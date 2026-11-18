import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import SpotShareLogo from './SpotShareLogo.jsx'
import ShaderBackdrop from './ShaderBackdrop.jsx'
import './LandingPage.css'

const API_BASE = (
  import.meta.env.VITE_API_BASE_URL ||
  (typeof window !== 'undefined' && window.location.hostname
    ? `http://${window.location.hostname}:8000`
    : 'http://localhost:8000')
).replace(/\/+$/, '')

const TAGLINE_WORDS =
  'Every kilowatt accounted for. Every parking bay guaranteed before your vehicle rolls out of the driveway.'.split(
    ' '
  )

const FAQS = [
  {
    q: 'How do I find and reserve a parking spot or EV charger near me?',
    a: 'Switch between Parking and EV Charging, search by Mysuru area or use GPS location inside the marketplace, compare live open bays and hourly rates, and lock in your exact time window.',
  },
  {
    q: 'What happens if I arrive earlier or need to cancel my reservation?',
    a: 'Barrier check-in opens 15 minutes before your booked start time. Confirmed bookings that have not checked in can also be cancelled anytime from My Bookings, immediately freeing the bay.',
  },
  {
    q: 'Can private homeowners list an EV charger on SpotShare?',
    a: 'Yes. Open the Host Hub portal to publish residential or commercial chargers with GPS auto-detection, hourly pricing, charger kW rating, supported vehicle types, and Turn Off / Close controls when out of town.',
  },
  {
    q: 'Can hosts pause their station temporarily without deleting their listing?',
    a: 'Yes. Hosts can use Turn Off / Close inside Host Hub at any time. Closed chargers stop accepting new reservations and update live Mysuru Hubs Online counts until reopened, while keeping your listing intact.',
  },
  {
    q: 'Which vehicles and EV charger speeds are supported?',
    a: 'SpotShare supports Cars (4-Wheelers), Bikes (2-Wheelers), and Vans/SUVs across Mysuru parking lots and EV hubs, ranging from 7.4 kW home chargers to 22 kW+ fast charging stations.',
  },
  {
    q: 'Do I receive confirmation details for my bookings?',
    a: 'Yes. Every confirmed reservation shows a live pass in My Bookings with directions, bay summary, and total cost, and SpotShare sends booking confirmation emails when an email address is on your account.',
  },
]

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180
  const R = 6371.0088
  const dLat = toRad(lat2 - lat1)
  const dLon = toRad(lon2 - lon1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

function isPrivateSpot(spot) {
  const owner = String(spot?.owner_name || '').trim().toLowerCase()
  if (owner && owner !== 'demo host') return true
  const am = (spot?.amenities || []).map((a) => String(a).toLowerCase())
  return am.some((a) => a.includes('private') || a.includes('home'))
}

async function fetchApiJson(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    const err = new Error(
      data && typeof data.detail === 'string' ? data.detail : `Request failed (${res.status})`
    )
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

export default function LandingPage({ spots = [], onOpenAuth, isLeaving = false }) {
  const taglineRef = useRef(null)

  const [liveSpots, setLiveSpots] = useState(spots)
  const [insights, setInsights] = useState(null)
  const [backendOnline, setBackendOnline] = useState(false)

  const [appMode, setAppMode] = useState('parking')
  const [stationFilter, setStationFilter] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [vehicleFilter, setVehicleFilter] = useState('all')
  const [defaultDuration, setDefaultDuration] = useState('2')
  const [userLocation, setUserLocation] = useState({ latitude: 12.2958, longitude: 76.6394 })
  const [gpsStatus, setGpsStatus] = useState('Use My GPS')

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [revealedWords, setRevealedWords] = useState(0)

  // Booking modal state
  const [bookingSpot, setBookingSpot] = useState(null)
  const [driverName, setDriverName] = useState('Showcase Driver')
  const [driverEmail, setDriverEmail] = useState('')
  const [bookingVehicle, setBookingVehicle] = useState('car')
  const [bookingHours, setBookingHours] = useState(2)
  const [bookingBusy, setBookingBusy] = useState(false)
  const [bookingFeedback, setBookingFeedback] = useState(null)

  const [openFaqIdx, setOpenFaqIdx] = useState(-1)

  useEffect(() => {
    if (Array.isArray(spots) && spots.length > 0) {
      setLiveSpots(spots)
    }
  }, [spots])

  const refreshLiveBackend = useCallback(async () => {
    try {
      const [health, spotsData, insightsData] = await Promise.all([
        fetchApiJson('/api/health'),
        fetchApiJson('/api/spots'),
        fetchApiJson('/api/insights').catch(() => null),
      ])
      setBackendOnline(Boolean(health && health.status === 'ok'))
      if (Array.isArray(spotsData) && spotsData.length > 0) {
        setLiveSpots(spotsData)
      }
      if (insightsData) setInsights(insightsData)
    } catch {
      setBackendOnline(false)
    }
  }, [])

  useEffect(() => {
    refreshLiveBackend()
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshLiveBackend()
      }
    }
    window.addEventListener('focus', refreshLiveBackend)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('focus', refreshLiveBackend)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refreshLiveBackend])

  // Word-by-word tagline scroll reveal
  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      setRevealedWords(TAGLINE_WORDS.length)
      return
    }

    let rafId = 0
    const updateReveal = () => {
      rafId = 0
      const el = taglineRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const vh = window.innerHeight || 800
      const progress = Math.min(
        Math.max((vh * 0.85 - rect.top) / (rect.height + vh * 0.4), 0),
        1
      )
      setRevealedWords(Math.floor(progress * TAGLINE_WORDS.length * 1.3))
    }

    const onScroll = () => {
      if (!rafId) rafId = requestAnimationFrame(updateReveal)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    updateReveal()
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])

  // Close modal / mobile menu on Escape
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setBookingSpot(null)
        setMobileMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const telemetry = useMemo(() => {
    const openSpots = liveSpots.filter((s) => s.is_active !== false && s.status !== 'closed')
    const freeBays =
      insights?.summary?.available_spaces ??
      openSpots.reduce((sum, s) => sum + Number(s.available_spaces ?? s.capacity ?? 0), 0)
    const totalKw = openSpots
      .filter((s) => s.ev_charging && s.charger_power_kw)
      .reduce((sum, s) => sum + Number(s.charger_power_kw || 0), 0)
    const prices = openSpots.map((s) => Number(s.price_per_hour)).filter((n) => Number.isFinite(n))
    const cheapest =
      insights?.cheapest_available_spot?.price_per_hour ??
      (prices.length ? Math.min(...prices) : 14)

    return {
      freeBays,
      totalKw: Math.round(totalKw),
      totalHubs: insights?.summary?.active_spots ?? openSpots.length,
      cheapest,
    }
  }, [liveSpots, insights])

  const filteredSpots = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    return liveSpots
      .map((s) => ({
        ...s,
        _dist:
          typeof s.distance_km === 'number'
            ? s.distance_km
            : haversineKm(userLocation.latitude, userLocation.longitude, s.latitude, s.longitude),
      }))
      .sort((a, b) => a._dist - b._dist)
      .filter((s) => {
        if (q && !`${s.name} ${s.address}`.toLowerCase().includes(q)) return false
        if (vehicleFilter !== 'all' && Array.isArray(s.vehicle_types) && !s.vehicle_types.includes(vehicleFilter)) {
          return false
        }
        if (stationFilter === 'parking') return !s.ev_charging
        if (stationFilter === 'ev') return Boolean(s.ev_charging)
        if (stationFilter === 'fast-ev') return Boolean(s.ev_charging) && Number(s.charger_power_kw || 0) >= 20
        if (stationFilter === 'private') return isPrivateSpot(s)
        return true
      })
      .slice(0, 9)
  }, [liveSpots, searchQuery, vehicleFilter, stationFilter, userLocation])

  const scrollTo = (id) => {
    setMobileMenuOpen(false)
    const el = document.getElementById(id)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const switchMode = (mode) => {
    setAppMode(mode)
    setStationFilter(mode === 'ev' ? 'ev' : 'parking')
  }

  const handleUseGps = () => {
    if (!navigator.geolocation) return
    setGpsStatus('Locating...')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setUserLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })
        setGpsStatus('GPS Active')
      },
      () => setGpsStatus('Mysuru Default'),
      { timeout: 6000 }
    )
  }

  const openModal = (spot) => {
    // Booking requires an account: send visitors to Customer Login instead of reserving as a guest.
    if (typeof onOpenAuth === 'function') {
      onOpenAuth('login')
      return
    }
    setBookingSpot(spot)
    const allowed = Array.isArray(spot.vehicle_types) && spot.vehicle_types.length ? spot.vehicle_types : ['car']
    setBookingVehicle(allowed[0])
    setBookingHours(Number(defaultDuration) || 2)
    setBookingFeedback(null)
  }

  const submitBooking = async (e) => {
    e.preventDefault()
    if (!bookingSpot) return
    setBookingBusy(true)
    setBookingFeedback(null)

    const startDt = new Date()
    const endDt = new Date(startDt.getTime() + bookingHours * 3600 * 1000)

    try {
      const created = await fetchApiJson('/api/bookings', {
        method: 'POST',
        body: {
          spot_id: bookingSpot.id,
          customer_name: driverName.trim() || 'Showcase Driver',
          customer_email: driverEmail.trim() || null,
          start_time: startDt.toISOString(),
          end_time: endDt.toISOString(),
          vehicle_type: bookingVehicle,
          requires_ev_charging: Boolean(bookingSpot.ev_charging),
        },
      })
      setBookingFeedback({
        kind: 'success',
        bookingId: created.id,
        totalPrice: created.total_price,
        emailSent: created.email_sent,
      })
      await refreshLiveBackend()
    } catch (err) {
      setBookingFeedback({
        kind: 'error',
        message: err.message,
      })
    } finally {
      setBookingBusy(false)
    }
  }

  return (
    <div className={`landing-page ${isLeaving ? 'is-leaving' : 'is-entering'}`}>
      <a href="#landing-main" className="landing-skip-link">
        Skip to content
      </a>

      <ShaderBackdrop mode={appMode} />

      <div className="landing-scroller">
        {/* Sticky Floating Navigation */}
        <header className="landing-nav-shell">
          <nav className="landing-nav" aria-label="Primary navigation">
            <a
              href="#top"
              className="landing-brand"
              onClick={(e) => {
                e.preventDefault()
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }}
            >
              <SpotShareLogo size={32} category={appMode} />
              <span className="landing-brand-text">
                <span className="brand-text-spot">Spot</span>
                <span className="brand-text-share">Share</span>
              </span>
            </a>

            <div className="lp-mode-pill" role="radiogroup" aria-label="Marketplace Mode">
              <button
                type="button"
                className={`lp-mode-btn ${appMode === 'parking' ? 'active-parking' : ''}`}
                role="radio"
                aria-checked={appMode === 'parking'}
                onClick={() => switchMode('parking')}
              >
                Parking
              </button>
              <button
                type="button"
                className={`lp-mode-btn ${appMode === 'ev' ? 'active-ev' : ''}`}
                role="radio"
                aria-checked={appMode === 'ev'}
                onClick={() => switchMode('ev')}
              >
                EV Charging
              </button>
            </div>

            <div className="landing-nav-links">
              <button type="button" className="landing-nav-link" onClick={() => scrollTo('network')}>
                Stations
              </button>
              <button type="button" className="landing-nav-link" onClick={() => scrollTo('host-hub')}>
                Host Hub
              </button>
              <button type="button" className="landing-nav-link" onClick={() => scrollTo('faq')}>
                FAQ
              </button>
            </div>

            <div className="landing-nav-actions">
              <button type="button" className="btn-landing-host" onClick={() => onOpenAuth('host')}>
                Host Hub Login
              </button>
              <button type="button" className="btn-landing-login" onClick={() => onOpenAuth('login')}>
                <span>Customer Login</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12h14M12 5l7 7-7 7" />
                </svg>
              </button>
              <button
                type="button"
                className="landing-mobile-toggle"
                aria-label={mobileMenuOpen ? 'Close menu' : 'Open menu'}
                aria-expanded={mobileMenuOpen}
                onClick={() => setMobileMenuOpen((v) => !v)}
              >
                {mobileMenuOpen ? '✕' : '☰'}
              </button>
            </div>
          </nav>

          {mobileMenuOpen && (
            <div className="landing-mobile-panel" role="dialog" aria-label="Mobile navigation">
              <div className="landing-mobile-links">
                <button type="button" onClick={() => scrollTo('network')}>Stations</button>
                <button type="button" onClick={() => scrollTo('host-hub')}>Host Hub</button>
                <button type="button" onClick={() => scrollTo('faq')}>FAQ</button>
              </div>
              <div className="landing-mobile-ctas">
                <button
                  type="button"
                  className="btn-landing-login"
                  style={{ width: '100%', justifyContent: 'center', padding: '12px' }}
                  onClick={() => {
                    setMobileMenuOpen(false)
                    onOpenAuth('login')
                  }}
                >
                  Customer Login
                </button>
                <button
                  type="button"
                  className="btn-landing-host"
                  style={{ width: '100%', textAlign: 'center', padding: '12px' }}
                  onClick={() => {
                    setMobileMenuOpen(false)
                    onOpenAuth('host')
                  }}
                >
                  Open Host Hub Login
                </button>
              </div>
            </div>
          )}
        </header>

        <main id="landing-main">
          {/* Hero Section */}
          <section id="top" className="lp-hero landing-container" aria-labelledby="hero-title">
            <div className="lp-hero-eyebrow">
              <span>
                Mysuru Hyperlocal Grid &bull; {liveSpots.length} Verified Locations
              </span>
            </div>

            <h1 className="lp-hero-title" id="hero-title">
              Guaranteed parking bays.
              <br />
              <span className="lp-accent">High-speed EV charging.</span>
              <br />
              Zero street search friction.
            </h1>

            <p className="lp-hero-sub">
              Stop circling crowded markets. Compare live bay availability, kW charging output, and transparent hourly rates across Mysuru, or list your home EV charger when your driveway is free.
            </p>

            {/* Search & Filter Bar */}
            <div className="lp-control-card">
              <form
                className="lp-filter-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  scrollTo('network')
                }}
              >
                <div className="lp-input-group">
                  <label className="lp-field-label" htmlFor="lp-search-loc">Destination or Area</label>
                  <input
                    id="lp-search-loc"
                    type="text"
                    className="lp-field-input"
                    placeholder="e.g. Mysuru Palace, Gokulam, Mall..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <div className="lp-input-group">
                  <label className="lp-field-label" htmlFor="lp-vehicle-sel">Vehicle Type</label>
                  <select
                    id="lp-vehicle-sel"
                    className="lp-field-input"
                    value={vehicleFilter}
                    onChange={(e) => setVehicleFilter(e.target.value)}
                  >
                    <option value="all">All Vehicles</option>
                    <option value="car">Car (4-Wheeler)</option>
                    <option value="bike">Bike (2-Wheeler)</option>
                    <option value="van">Van / SUV</option>
                  </select>
                </div>

                <div className="lp-input-group">
                  <label className="lp-field-label" htmlFor="lp-dur-sel">Duration</label>
                  <select
                    id="lp-dur-sel"
                    className="lp-field-input"
                    value={defaultDuration}
                    onChange={(e) => setDefaultDuration(e.target.value)}
                  >
                    <option value="1">1 Hour</option>
                    <option value="2">2 Hours</option>
                    <option value="3">3 Hours</option>
                    <option value="5">5 Hours</option>
                  </select>
                </div>

                <button type="submit" className="lp-btn-search">
                  <span>Explore Bays</span>
                </button>
              </form>
            </div>


            {/* Live Telemetry Strip */}
            <div className="lp-telemetry-strip">
              <div className="lp-telemetry-card">
                <span className="lp-telemetry-num">{telemetry.freeBays}</span>
                <span className="lp-telemetry-lbl">Available Bays Now</span>
              </div>
              <div className="lp-telemetry-card">
                <span className="lp-telemetry-num">{telemetry.totalKw} kW</span>
                <span className="lp-telemetry-lbl">Active Charger Capacity</span>
              </div>
              <div className="lp-telemetry-card">
                <span className="lp-telemetry-num">{telemetry.totalHubs}</span>
                <span className="lp-telemetry-lbl">Mysuru Hubs Online</span>
              </div>
              <div className="lp-telemetry-card">
                <span className="lp-telemetry-num">&#8377;{telemetry.cheapest}/hr</span>
                <span className="lp-telemetry-lbl">Lowest Open Rate</span>
              </div>
            </div>
          </section>

          {/* Live Stations Explorer */}
          <section id="network" className="lp-section landing-container" aria-labelledby="spots-heading">
            <div className="lp-section-header">
              <div>
                <h2 className="lp-section-heading" id="spots-heading">Explore live stations near you.</h2>
              </div>

              <div className="lp-chips" role="group" aria-label="Filter stations">
                {[
                  { id: 'all', label: 'All Stations' },
                  { id: 'parking', label: 'Parking Lots' },
                  { id: 'ev', label: 'EV Charging' },
                ].map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={`lp-chip ${stationFilter === c.id ? 'active' : ''}`}
                    onClick={() => setStationFilter(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="lp-spots-grid">
              {filteredSpots.length === 0 ? (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    textAlign: 'center',
                    padding: '48px 24px',
                    background: 'rgba(17,26,46,0.7)',
                    borderRadius: '20px',
                    border: '1px solid var(--lp-border)',
                  }}
                >
                  <p style={{ marginBottom: '14px', color: 'var(--lp-text-secondary)' }}>
                    No stations matched your filters.
                  </p>
                  <button
                    type="button"
                    className="lp-chip active"
                    onClick={() => {
                      setSearchQuery('')
                      setVehicleFilter('all')
                      setStationFilter('all')
                    }}
                  >
                    Reset Filters
                  </button>
                </div>
              ) : (
                filteredSpots.map((spot) => {
                  const isClosed = spot.is_active === false || spot.status === 'closed'
                  const free = isClosed ? 0 : Math.max(0, Number(spot.available_spaces ?? 0))
                  const isFastEv = Boolean(spot.ev_charging) && Number(spot.charger_power_kw || 0) >= 20
                  const badgeClass = isClosed ? 'closed' : isFastEv ? 'ev-fast' : 'available'
                  const badgeText = isClosed
                    ? '● CLOSED'
                    : spot.ev_charging
                      ? `⚡ ${spot.charger_power_kw || 11} kW EV`
                      : '● AVAILABLE'

                  return (
                    <article key={spot.id} className={`lp-spot-card ${isClosed ? 'is-closed' : ''}`}>
                      <div className="lp-spot-media">
                        <img
                          src={spot.image_url || `/images/spots/${spot.id}.jpg`}
                          alt={spot.name}
                          loading="lazy"
                          onError={(e) => {
                            e.currentTarget.onerror = null
                            e.currentTarget.src = spot.ev_charging
                              ? 'https://images.unsplash.com/photo-1593941707882-a5bba14938c7?auto=format&fit=crop&w=700&q=80'
                              : 'https://images.unsplash.com/photo-1506521781263-d8422e82f27a?auto=format&fit=crop&w=700&q=80'
                          }}
                        />
                        <div className="lp-badge-row">
                          <span className={`lp-badge ${badgeClass}`}>{badgeText}</span>
                          <span className="lp-badge dist">{spot._dist.toFixed(1)} km</span>
                        </div>
                      </div>

                      <div className="lp-spot-body">
                        <h3 className="lp-spot-title">{spot.name}</h3>
                        <p className="lp-spot-addr">{spot.address}</p>

                        <div className="lp-spot-specs">
                          <span>{isClosed ? 'Host paused' : `${free} / ${spot.capacity || 1} bays free`}</span>
                          <span>&bull;</span>
                          <span>
                            {spot.ev_charging
                              ? `${spot.charger_power_kw || 11} kW Charger`
                              : (spot.vehicle_types || ['car', 'bike']).map((v) => v.toUpperCase()).join(' / ')}
                          </span>
                        </div>

                        <div className="lp-spot-footer">
                          <div>
                            <span className="lp-price-num">
                              &#8377;{spot.price_per_hour}
                              <span className="lp-price-unit">/hr</span>
                            </span>
                            {spot.owner_name && spot.owner_name !== 'Demo Host' && (
                              <span className="lp-host-sub">{spot.owner_name}</span>
                            )}
                          </div>

                          <button
                            type="button"
                            className="lp-btn-reserve"
                            disabled={isClosed || free === 0}
                            onClick={() => openModal(spot)}
                          >
                            {isClosed ? 'Closed' : free === 0 ? 'Full' : 'Reserve Bay'}
                          </button>
                        </div>
                      </div>
                    </article>
                  )
                })
              )}
            </div>
          </section>

          {/* Mandatory Tagline Reveal */}
          <section id="tagline" className="lp-tagline-section landing-container" aria-label="Mission Statement">
            <h2 className="lp-tagline-text" ref={taglineRef}>
              {TAGLINE_WORDS.map((word, idx) => {
                const lower = word.toLowerCase()
                const isAccent = lower.includes('kilowatt') || lower.includes('guaranteed')
                const isRevealed = idx <= revealedWords
                return (
                  <span
                    key={`${word}-${idx}`}
                    className={`lp-reveal-word ${isAccent ? 'accent' : ''} ${isRevealed ? 'revealed' : ''}`}
                  >
                    {word}
                  </span>
                )
              })}
            </h2>
          </section>

          {/* Host Hub */}
          <section id="host-hub" className="lp-section landing-container" aria-labelledby="host-heading">
            <div className="lp-host-showcase">
              <div className="lp-host-header">
                <div className="lp-host-intro">
                  <h2 className="lp-section-heading" id="host-heading">
                    Monetize idle bays. Power clean urban transit.
                  </h2>
                  <p className="lp-host-sub">
                    Publish your EV charging station or driveway bay in minutes, monitor occupancy and earnings live, and pause bookings temporarily whenever you travel.
                  </p>
                </div>

                <button type="button" className="btn-landing-login lp-host-cta" onClick={() => onOpenAuth('host')}>
                  <span>Open Host Hub Login</span>
                  <span>&rarr;</span>
                </button>
              </div>

              <ul className="lp-host-features-grid">
                <li className="lp-host-feature-card">
                  <div className="lp-feature-icon" aria-hidden="true">✓</div>
                  <h3>Temporary Turn Off / Close Mode</h3>
                  <p>
                    Pause new bookings while preserving your listing details, rating, and booking history.
                  </p>
                </li>
                <li className="lp-host-feature-card">
                  <div className="lp-feature-icon" aria-hidden="true">✓</div>
                  <h3>Atomic Anti-Clash Reservations</h3>
                  <p>
                    Database transaction locks prevent overlapping double-bookings during concurrent requests.
                  </p>
                </li>
                <li className="lp-host-feature-card">
                  <div className="lp-feature-icon" aria-hidden="true">✓</div>
                  <h3>Direct Host Dashboard &amp; Analytics</h3>
                  <p>
                    View booked revenue, active sessions, and live bay utilization in one place.
                  </p>
                </li>
              </ul>
            </div>
          </section>

          {/* FAQ */}
          <section id="faq" className="lp-section landing-container" aria-labelledby="faq-heading">
            <div className="lp-faq-wrap">
              <h3 id="faq-heading" style={{ fontSize: '1.55rem', fontWeight: 700, marginBottom: '20px', textAlign: 'center' }}>
                Frequently Asked Questions
              </h3>
              {FAQS.map((item, idx) => {
                const isOpen = openFaqIdx === idx
                return (
                  <div key={item.q} className="lp-faq-item">
                    <button
                      type="button"
                      className="lp-faq-trigger"
                      aria-expanded={isOpen}
                      onClick={() => setOpenFaqIdx(isOpen ? -1 : idx)}
                    >
                      <span>{item.q}</span>
                      <span>{isOpen ? '▴' : '▾'}</span>
                    </button>
                    {isOpen && <p className="lp-faq-answer">{item.a}</p>}
                  </div>
                )
              })}
            </div>
          </section>

          {/* Final CTA */}
          <section className="lp-final-cta landing-container" aria-label="Call to action">
            <div className="lp-final-cta-box">
              <h2 className="lp-hero-title" style={{ fontSize: 'clamp(1.9rem, 4.2vw, 3.2rem)', marginBottom: '12px' }}>
                Reserve your bay or start hosting today.
              </h2>
              <p style={{ color: '#cbd5e1', maxWidth: '620px', margin: '0 auto', fontSize: '1.02rem' }}>
                Open the full interactive Leaflet map marketplace or manage your EV chargers in the Host Hub.
              </p>

              <div className="lp-cta-row">
                <button type="button" className="lp-btn-cta-primary" onClick={() => onOpenAuth('login')}>
                  <span>Open Customer Marketplace</span>
                  <span>&rarr;</span>
                </button>
                <button type="button" className="lp-btn-cta-secondary" onClick={() => onOpenAuth('host')}>
                  Open Host Hub Login
                </button>
              </div>
            </div>
          </section>
        </main>

        {/* Footer */}
        <footer className="lp-footer">
          <div className="landing-container">
            <div className="lp-footer-grid">
              <div>
                <div className="landing-brand" style={{ marginBottom: '10px' }}>
                  <SpotShareLogo size={28} category={appMode} />
                  <span className="landing-brand-text">
                    <span className="brand-text-spot">Spot</span>
                    <span className="brand-text-share">Share</span>
                  </span>
                </div>
                <p style={{ fontSize: '0.84rem', lineHeight: 1.6, maxWidth: '320px' }}>
                  Verified parking bays and EV charging stations across Mysuru, ready to reserve before you drive.
                </p>
              </div>

              <div>
                <h4>Portals</h4>
                <ul className="lp-footer-links">
                  <li><button type="button" onClick={() => onOpenAuth('login')}>Customer Marketplace</button></li>
                  <li><button type="button" onClick={() => onOpenAuth('host')}>Host Hub Login</button></li>
                </ul>
              </div>

              <div>
                <h4>Explore</h4>
                <ul className="lp-footer-links">
                  <li><button type="button" onClick={() => scrollTo('network')}>Live Stations</button></li>
                  <li><button type="button" onClick={() => scrollTo('host-hub')}>Host Hub</button></li>
                </ul>
              </div>

              <div>
                <h4>Coverage</h4>
                <ul className="lp-footer-links">
                  <li><span>Mysuru, Karnataka</span></li>
                  <li><span>Parking &amp; EV Charging</span></li>
                </ul>
              </div>
            </div>

            <div className="lp-footer-bottom">
              <span>&copy; 2026 SpotShare Network. Mysuru, Karnataka.</span>
              <button
                type="button"
                style={{ background: 'none', border: 'none', color: '#94a3b8', cursor: 'pointer', fontFamily: 'inherit' }}
                onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              >
                Back to top &uarr;
              </button>
            </div>
          </div>
        </footer>
      </div>

      {/* Live Reservation Modal */}
      {bookingSpot && (
        <div
          className="lp-modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="lp-modal-title"
          onClick={() => setBookingSpot(null)}
        >
          <div className="lp-modal-dialog" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="lp-modal-close"
              aria-label="Close modal"
              onClick={() => setBookingSpot(null)}
            >
              &times;
            </button>
            <span className="lp-tag" style={{ color: 'var(--lp-emerald-glow)' }}>// Instant Reservation</span>
            <h3 id="lp-modal-title" style={{ color: '#ffffff', fontSize: '1.3rem', marginBottom: '4px' }}>
              {bookingSpot.name}
            </h3>
            <p style={{ color: 'var(--lp-text-secondary)', fontSize: '0.84rem', marginBottom: '16px' }}>
              {bookingSpot.address}
            </p>

            <div style={{ background: 'rgba(0,0,0,0.45)', padding: '12px 14px', borderRadius: '10px', marginBottom: '14px', fontSize: '0.84rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ color: 'var(--lp-text-muted)' }}>Hourly Rate:</span>
                <strong>&#8377;{bookingSpot.price_per_hour} / hr</strong>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--lp-text-muted)' }}>Availability:</span>
                <span style={{ color: 'var(--lp-emerald-glow)' }}>
                  {bookingSpot.available_spaces ?? bookingSpot.capacity} of {bookingSpot.capacity} bays open
                </span>
              </div>
            </div>

            <form onSubmit={submitBooking}>
              <div className="lp-modal-grid">
                <div>
                  <label className="lp-field-label" htmlFor="lp-bk-name">Driver Name</label>
                  <input
                    id="lp-bk-name"
                    type="text"
                    className="lp-modal-input"
                    value={driverName}
                    onChange={(e) => setDriverName(e.target.value)}
                    required
                  />
                </div>
                <div>
                  <label className="lp-field-label" htmlFor="lp-bk-email">Email (Optional Receipt)</label>
                  <input
                    id="lp-bk-email"
                    type="email"
                    className="lp-modal-input"
                    placeholder="driver@example.com"
                    value={driverEmail}
                    onChange={(e) => setDriverEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className="lp-modal-grid">
                <div>
                  <label className="lp-field-label" htmlFor="lp-bk-veh">Vehicle</label>
                  <select
                    id="lp-bk-veh"
                    className="lp-modal-input"
                    value={bookingVehicle}
                    onChange={(e) => setBookingVehicle(e.target.value)}
                  >
                    {(bookingSpot.vehicle_types || ['car']).map((v) => (
                      <option key={v} value={v}>
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="lp-field-label" htmlFor="lp-bk-hrs">Duration</label>
                  <select
                    id="lp-bk-hrs"
                    className="lp-modal-input"
                    value={bookingHours}
                    onChange={(e) => setBookingHours(Number(e.target.value))}
                  >
                    <option value={1}>1 Hour</option>
                    <option value={2}>2 Hours</option>
                    <option value={3}>3 Hours</option>
                    <option value={5}>5 Hours</option>
                  </select>
                </div>
              </div>

              {bookingFeedback && (
                <div className={`lp-modal-feedback ${bookingFeedback.kind}`}>
                  {bookingFeedback.kind === 'success' ? (
                    <>
                      <strong>Booking Confirmed in SQLite!</strong>
                      <br />
                      Voucher ID: <code>{bookingFeedback.bookingId}</code> &bull; Total:{' '}
                      <strong>&#8377;{bookingFeedback.totalPrice}</strong>
                    </>
                  ) : (
                    <span>Booking failed: {bookingFeedback.message}</span>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px', paddingTop: '14px', borderTop: '1px solid var(--lp-border)' }}>
                <div>
                  <span style={{ fontSize: '0.75rem', color: 'var(--lp-text-muted)' }}>Estimated Total</span>
                  <div style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: '1.4rem', fontWeight: 800 }}>
                    &#8377;{(Number(bookingSpot.price_per_hour || 0) * bookingHours).toFixed(2).replace(/\.00$/, '')}
                  </div>
                </div>
                <button type="submit" className="lp-btn-reserve" disabled={bookingBusy}>
                  {bookingBusy ? 'Reserving...' : 'Confirm Reservation'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
