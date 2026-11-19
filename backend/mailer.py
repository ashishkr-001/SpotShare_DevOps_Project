"""Email delivery helper for SpotShare (Brevo HTTPS API + Gmail SMTP fallback).

Reads configuration from process environment variables first, falling back to
`backend/.env` so local configuration changes take effect immediately.
Uses Brevo's HTTPS v3 API when SPOTSHARE_BREVO_API_KEY is configured (required on
cloud hosts like Railway Free/Trial/Hobby where outbound SMTP ports are blocked),
and falls back to stdlib smtplib otherwise.
"""
from __future__ import annotations

import html
import json
import os
import smtplib
import ssl
import urllib.error
import urllib.request
from datetime import datetime
from email.message import EmailMessage
from email.utils import parseaddr
from pathlib import Path
from typing import Any, Dict, Optional

from database import ServiceError

ENV_PATH = Path(__file__).resolve().parent / ".env"
BREVO_API_URL = "https://api.brevo.com/v3/smtp/email"


def _read_dotenv(path: Optional[Path] = None) -> Dict[str, str]:
    target = ENV_PATH if path is None else path
    values: Dict[str, str] = {}
    if not target.is_file():
        return values
    try:
        for raw_line in target.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, val = line.split("=", 1)
            key = key.strip()
            val = val.strip()
            if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
                val = val[1:-1]
            if key:
                values[key] = val
    except OSError:
        return {}
    return values


def _env(key: str, dotenv_values: Dict[str, str], default: str = "") -> str:
    val = os.getenv(key)
    if val is not None and val != "":
        return val
    return dotenv_values.get(key, default)


def get_smtp_config() -> Dict[str, object]:
    dotenv_values = _read_dotenv()
    host = _env("SPOTSHARE_SMTP_HOST", dotenv_values, "smtp.gmail.com").strip() or "smtp.gmail.com"
    port_raw = _env("SPOTSHARE_SMTP_PORT", dotenv_values, "587").strip()
    try:
        port = int(port_raw)
    except ValueError:
        port = 587
    user = _env("SPOTSHARE_SMTP_USER", dotenv_values, "").strip()
    # Gmail App Passwords are often copied with spaces every 4 characters
    password = _env("SPOTSHARE_SMTP_PASSWORD", dotenv_values, "").replace(" ", "").strip()
    sender = (
        _env("SPOTSHARE_EMAIL_FROM", dotenv_values, "").strip()
        or _env("SPOTSHARE_SMTP_FROM", dotenv_values, "").strip()
        or user
    )
    return {
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "sender": sender,
    }


def get_brevo_config() -> Dict[str, str]:
    dotenv_values = _read_dotenv()
    api_key = _env("SPOTSHARE_BREVO_API_KEY", dotenv_values, "").strip()
    sender = (
        _env("SPOTSHARE_EMAIL_FROM", dotenv_values, "").strip()
        or _env("SPOTSHARE_SMTP_FROM", dotenv_values, "").strip()
        or _env("SPOTSHARE_SMTP_USER", dotenv_values, "").strip()
    )
    return {
        "api_key": api_key,
        "sender": sender,
    }


def _parse_sender(sender_raw: str) -> Dict[str, str]:
    name, addr = parseaddr(sender_raw.strip())
    email_addr = addr or sender_raw.strip()
    return {"name": name or "SpotShare", "email": email_addr}


def _extract_message_bodies(msg: EmailMessage) -> tuple[str, str]:
    plain_part = msg.get_body(preferencelist=("plain",))
    html_part = msg.get_body(preferencelist=("html",))
    text_body = str(plain_part.get_content()) if plain_part is not None else ""
    html_body = str(html_part.get_content()) if html_part is not None else ""
    if not html_body and text_body:
        html_body = f"<pre>{html.escape(text_body)}</pre>"
    return text_body, html_body


def _send_via_brevo(msg: EmailMessage, to_email: str, api_key: str, sender_raw: str) -> None:
    if not sender_raw:
        raise ServiceError(
            503,
            "email_not_configured",
            "Brevo sender email is not configured. Set SPOTSHARE_EMAIL_FROM (or SPOTSHARE_SMTP_USER) "
            "to a verified sender email in your Brevo account.",
        )

    text_body, html_body = _extract_message_bodies(msg)
    _, to_addr = parseaddr(to_email.strip())
    payload: Dict[str, Any] = {
        "sender": _parse_sender(sender_raw),
        "to": [{"email": to_addr or to_email.strip()}],
        "subject": str(msg["Subject"] or "SpotShare Notification"),
        "htmlContent": html_body,
    }
    if text_body:
        payload["textContent"] = text_body

    req = urllib.request.Request(
        BREVO_API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "accept": "application/json",
            "content-type": "application/json",
            "api-key": api_key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status >= 400:
                raise ServiceError(
                    502,
                    "email_send_failed",
                    f"Brevo API returned unexpected status {resp.status}.",
                )
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            raw_err = exc.read().decode("utf-8", errors="replace")
            parsed = json.loads(raw_err)
            if isinstance(parsed, dict) and parsed.get("message"):
                detail = str(parsed["message"])
            else:
                detail = raw_err[:200]
        except Exception:
            detail = str(exc.reason or exc.code)
        if exc.code == 401:
            raise ServiceError(
                502,
                "email_auth_failed",
                f"Brevo API key authentication failed ({detail}). Verify SPOTSHARE_BREVO_API_KEY.",
            ) from exc
        raise ServiceError(
            502,
            "email_send_failed",
            f"Could not send email to {to_email} via Brevo: {detail}",
        ) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise ServiceError(
            502,
            "email_send_failed",
            f"Could not reach Brevo email API: {exc}",
        ) from exc


def _send_via_smtp(msg: EmailMessage, to_email: str, cfg: Dict[str, object]) -> None:
    user = str(cfg["user"])
    password = str(cfg["password"])
    host = str(cfg["host"])
    port = int(cfg["port"])
    sender = str(cfg["sender"])

    msg["From"] = sender
    msg["To"] = to_email

    context = ssl.create_default_context()
    try:
        if port == 465:
            with smtplib.SMTP_SSL(host, port, context=context, timeout=15) as server:
                server.login(user, password)
                server.send_message(msg)
        else:
            with smtplib.SMTP(host, port, timeout=15) as server:
                server.ehlo()
                server.starttls(context=context)
                server.ehlo()
                server.login(user, password)
                server.send_message(msg)
    except smtplib.SMTPAuthenticationError as exc:
        raise ServiceError(
            502,
            "email_auth_failed",
            "Gmail SMTP authentication failed. Verify SPOTSHARE_SMTP_USER and ensure SPOTSHARE_SMTP_PASSWORD "
            "in backend/.env is a valid 16-character Gmail App Password.",
        ) from exc
    except (smtplib.SMTPException, OSError) as exc:
        raise ServiceError(
            502,
            "email_send_failed",
            f"Could not send email to {to_email}: {exc}",
        ) from exc


def _send_email_message(msg: EmailMessage, to_email: str) -> None:
    brevo_cfg = get_brevo_config()
    if brevo_cfg["api_key"]:
        _send_via_brevo(msg, to_email, brevo_cfg["api_key"], brevo_cfg["sender"])
        return

    smtp_cfg = get_smtp_config()
    if str(smtp_cfg["user"]) and str(smtp_cfg["password"]):
        _send_via_smtp(msg, to_email, smtp_cfg)
        return

    raise ServiceError(
        503,
        "email_not_configured",
        "Email service is not configured yet. Set SPOTSHARE_BREVO_API_KEY and SPOTSHARE_EMAIL_FROM "
        "(recommended for Railway), or SPOTSHARE_SMTP_USER and SPOTSHARE_SMTP_PASSWORD in backend/.env.",
    )


def send_reset_code_email(*, to_email: str, recipient_name: str, code: str, role: str) -> None:
    role_label = "Host Hub" if role == "host" else "Customer"
    display_name = recipient_name.strip() or "User"
    safe_display_name = html.escape(display_name)

    msg = EmailMessage()
    msg["Subject"] = f"SpotShare Password Reset Code: {code}"
    msg.set_content(
        f"Hi {display_name},\n\n"
        f"Your SpotShare ({role_label}) password reset verification code is:\n\n"
        f"    {code}\n\n"
        f"This code expires in 10 minutes. If you did not request a password reset, you can ignore this email.\n\n"
        f"— SpotShare Security"
    )
    msg.add_alternative(
        f"""\
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; color: #0f172a;">
          <h2 style="margin: 0 0 8px; color: #2563eb;">SpotShare Password Reset</h2>
          <p style="margin: 0 0 16px; color: #475569; font-size: 14px;">
            Hi {safe_display_name}, use the 6-digit verification code below to reset your SpotShare ({role_label}) password:
          </p>
          <div style="background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 10px; padding: 16px; text-align: center; font-size: 28px; font-weight: 800; letter-spacing: 6px; color: #0f172a; margin-bottom: 16px;">
            {code}
          </div>
          <p style="margin: 0; color: #64748b; font-size: 12px;">
            This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.
          </p>
        </div>
        """,
        subtype="html",
    )
    _send_email_message(msg, to_email)


def _format_ist(iso_str: str) -> str:
    try:
        dt = datetime.fromisoformat(iso_str)
        return dt.strftime("%d %b %Y, %I:%M %p")
    except ValueError:
        return iso_str


def _format_duration(minutes: float) -> str:
    mins = max(1, int(round(minutes)))
    hrs, rem = divmod(mins, 60)
    if hrs and rem:
        return f"{hrs} hr{'s' if hrs != 1 else ''} {rem} min{'s' if rem != 1 else ''}"
    if hrs:
        return f"{hrs} hr{'s' if hrs != 1 else ''}"
    return f"{rem} mins"


def _format_money(amount: float) -> str:
    formatted = f"{amount:.2f}".rstrip("0").rstrip(".")
    return f"₹{formatted}"


def send_booking_confirmation_email(*, to_email: str, booking: Dict[str, Any], spot: Dict[str, Any]) -> None:
    is_ev = bool(spot.get("ev_charging") or booking.get("requires_ev_charging"))
    accent = "#059669" if is_ev else "#2563eb"
    badge_bg = "#ecfdf5" if is_ev else "#eff6ff"
    badge_border = "#a7f3d0" if is_ev else "#bfdbfe"
    category_label = "EV Charging" if is_ev else "Parking Space"
    if is_ev and spot.get("charger_power_kw"):
        category_label = f"EV Charging ({spot['charger_power_kw']} kW)"

    spot_name = str(booking.get("spot_name") or spot.get("name") or "SpotShare Location")
    spot_address = str(spot.get("address") or "Mysuru")
    customer_name = str(booking.get("customer_name") or "Customer")
    booking_id = str(booking.get("id") or "")
    vehicle_type = str(booking.get("vehicle_type") or "car").capitalize()
    checkin = _format_ist(str(booking.get("start_time") or ""))
    checkout = _format_ist(str(booking.get("end_time") or ""))
    duration = _format_duration(float(booking.get("duration_minutes") or 0))
    total = _format_money(float(booking.get("total_price") or 0))
    lat = spot.get("latitude")
    lng = spot.get("longitude")
    maps_url = (
        f"https://www.google.com/maps/dir/?api=1&destination={lat},{lng}"
        if lat is not None and lng is not None
        else ""
    )

    msg = EmailMessage()
    msg["Subject"] = f"SpotShare {category_label} Confirmed: {spot_name} ({booking_id})"
    directions_text = f"\nDirections: {maps_url}\n" if maps_url else "\n"
    msg.set_content(
        f"Hi {customer_name},\n\n"
        f"Your SpotShare reservation is confirmed!\n\n"
        f"Booking ID: {booking_id}\n"
        f"Location: {spot_name}\n"
        f"Address: {spot_address}\n"
        f"Category: {category_label}\n"
        f"Vehicle: {vehicle_type}\n"
        f"Check-in: {checkin}\n"
        f"Check-out: {checkout}\n"
        f"Duration: {duration}\n"
        f"Total Amount: {total}\n"
        f"{directions_text}\n"
        f"Need to make changes? Manage or cancel your booking anytime in My Bookings on SpotShare.\n\n"
        f"— SpotShare Mysuru"
    )

    directions_html = (
        f'<div style="margin-top: 18px; text-align: center;">'
        f'<a href="{html.escape(maps_url)}" style="display: inline-block; background: {accent}; color: #ffffff; '
        f'text-decoration: none; font-weight: 600; font-size: 14px; padding: 10px 18px; border-radius: 8px;">'
        f'Open Directions in Google Maps</a></div>'
        if maps_url
        else ""
    )

    msg.add_alternative(
        f"""\
        <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 520px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 14px; color: #0f172a; background: #ffffff;">
          <div style="display: inline-block; background: {badge_bg}; color: {accent}; border: 1px solid {badge_border}; border-radius: 999px; padding: 4px 12px; font-size: 12px; font-weight: 700; margin-bottom: 10px;">
            {html.escape(category_label)} Confirmed
          </div>
          <h2 style="margin: 0 0 4px; font-size: 20px; color: #0f172a;">{html.escape(spot_name)}</h2>
          <p style="margin: 0 0 18px; color: #64748b; font-size: 13px;">{html.escape(spot_address)}</p>

          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px;">
            <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
              <tr><td style="padding: 5px 0; color: #64748b;">Booking ID</td><td style="padding: 5px 0; text-align: right; font-weight: 700; color: #0f172a;">{html.escape(booking_id)}</td></tr>
              <tr><td style="padding: 5px 0; color: #64748b;">Customer</td><td style="padding: 5px 0; text-align: right; font-weight: 600;">{html.escape(customer_name)}</td></tr>
              <tr><td style="padding: 5px 0; color: #64748b;">Vehicle</td><td style="padding: 5px 0; text-align: right; font-weight: 600;">{html.escape(vehicle_type)}</td></tr>
              <tr><td style="padding: 5px 0; color: #64748b;">Check-in</td><td style="padding: 5px 0; text-align: right; font-weight: 600;">{html.escape(checkin)}</td></tr>
              <tr><td style="padding: 5px 0; color: #64748b;">Check-out</td><td style="padding: 5px 0; text-align: right; font-weight: 600;">{html.escape(checkout)}</td></tr>
              <tr><td style="padding: 5px 0; color: #64748b;">Duration</td><td style="padding: 5px 0; text-align: right; font-weight: 600;">{html.escape(duration)}</td></tr>
              <tr><td style="padding: 10px 0 2px; border-top: 1px solid #e2e8f0; font-weight: 700; color: #0f172a;">Total Amount</td><td style="padding: 10px 0 2px; border-top: 1px solid #e2e8f0; text-align: right; font-size: 16px; font-weight: 800; color: {accent};">{html.escape(total)}</td></tr>
            </table>
          </div>
          {directions_html}
          <p style="margin: 18px 0 0; color: #64748b; font-size: 12px; text-align: center;">
            Need to change plans? You can view or cancel anytime in My Bookings on SpotShare.
          </p>
        </div>
        """,
        subtype="html",
    )
    _send_email_message(msg, to_email)
