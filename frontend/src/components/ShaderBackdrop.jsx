import { useEffect, useRef } from 'react'

/**
 * Full-screen WebGL custom GLSL backdrop with 4x4 Bayer dithering,
 * Voronoi fluid waves, damped pointer ripples, and smooth mode morphing.
 * Pauses automatically when hidden and respects prefers-reduced-motion.
 */
export default function ShaderBackdrop({ mode = 'parking' }) {
  const canvasRef = useRef(null)
  const modeValueRef = useRef(mode === 'ev' || mode === 'host' ? 1.0 : 0.0)

  useEffect(() => {
    modeValueRef.current = mode === 'ev' || mode === 'host' ? 1.0 : 0.0
  }, [mode])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) return

    const gl = canvas.getContext('webgl', { antialias: false, powerPreference: 'high-performance' })
    if (!gl) return

    const vertexSource = `
      attribute vec2 a_position;
      varying vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `
    const fragmentSource = `
      precision mediump float;
      uniform vec2 u_resolution;
      uniform vec2 u_mouse;
      uniform float u_time;
      uniform float u_mode;
      varying vec2 v_uv;

      float bayer4(vec2 p) {
        mat4 m = mat4(
           0.0/16.0, 12.0/16.0,  3.0/16.0, 15.0/16.0,
           8.0/16.0,  4.0/16.0, 11.0/16.0,  7.0/16.0,
           2.0/16.0, 14.0/16.0,  1.0/16.0, 13.0/16.0,
          10.0/16.0,  6.0/16.0,  9.0/16.0,  5.0/16.0
        );
        int x = int(mod(p.x, 4.0));
        int y = int(mod(p.y, 4.0));
        if (x == 0) {
          if (y == 0) return m[0][0]; if (y == 1) return m[0][1]; if (y == 2) return m[0][2]; return m[0][3];
        } else if (x == 1) {
          if (y == 0) return m[1][0]; if (y == 1) return m[1][1]; if (y == 2) return m[1][2]; return m[1][3];
        } else if (x == 2) {
          if (y == 0) return m[2][0]; if (y == 1) return m[2][1]; if (y == 2) return m[2][2]; return m[2][3];
        } else {
          if (y == 0) return m[3][0]; if (y == 1) return m[3][1]; if (y == 2) return m[3][2]; return m[3][3];
        }
      }

      vec3 hash3(vec2 p) {
        vec3 q = vec3(dot(p, vec2(127.1, 311.7)),
                      dot(p, vec2(269.5, 183.3)),
                      dot(p, vec2(419.2, 371.9)));
        return fract(sin(q) * 43758.5453);
      }

      float voronoi(vec2 x) {
        vec2 p = floor(x);
        vec2 f = fract(x);
        float res = 8.0;
        for (int j = -1; j <= 1; j++) {
          for (int i = -1; i <= 1; i++) {
            vec2 b = vec2(float(i), float(j));
            vec2 r = b - f + hash3(p + b).xy;
            float d = dot(r, r);
            res = min(res, d);
          }
        }
        return sqrt(res);
      }

      void main() {
        vec2 st = gl_FragCoord.xy / u_resolution.xy;
        st.y = 1.0 - st.y;
        float aspect = u_resolution.x / u_resolution.y;
        vec2 p = st;
        p.x *= aspect;

        vec2 m = u_mouse / u_resolution.xy;
        m.y = 1.0 - m.y;
        m.x *= aspect;

        float distToMouse = length(p - m);
        float mouseWave = sin(distToMouse * 14.0 - u_time * 3.5) * exp(-distToMouse * 3.0) * 0.12;

        float t = u_time * 0.35;
        vec2 flow = vec2(sin(p.y * 2.5 + t), cos(p.x * 2.5 + t)) * 0.25;
        float v = voronoi(p * 2.5 + flow + mouseWave);

        vec3 blueVoid = vec3(0.04, 0.07, 0.15);
        vec3 blueMid  = vec3(0.12, 0.23, 0.55);
        vec3 blueGlow = vec3(0.15, 0.39, 0.92);
        vec3 cyanBeam = vec3(0.02, 0.71, 0.83);

        vec3 greenVoid = vec3(0.02, 0.05, 0.08);
        vec3 greenMid  = vec3(0.03, 0.31, 0.23);
        vec3 greenGlow = vec3(0.06, 0.73, 0.51);
        vec3 greenBeam = vec3(0.20, 0.83, 0.60);

        vec3 baseVoid = mix(blueVoid, greenVoid, u_mode);
        vec3 baseMid  = mix(blueMid, greenMid, u_mode);
        vec3 baseGlow = mix(blueGlow, greenGlow, u_mode);
        vec3 baseBeam = mix(cyanBeam, greenBeam, u_mode);

        float intensity = smoothstep(0.85, 0.15, v);
        vec3 col = mix(baseVoid, baseMid, intensity);
        col = mix(col, baseGlow, smoothstep(0.4, 0.9, intensity + mouseWave * 1.5));
        col += baseBeam * pow(intensity, 4.0) * 0.45;

        float vig = 16.0 * st.x * st.y * (1.0 - st.x) * (1.0 - st.y);
        col *= clamp(pow(vig, 0.28), 0.0, 1.0);

        float dither = bayer4(gl_FragCoord.xy);
        col += (dither - 0.5) * 0.032;

        gl_FragColor = vec4(col, 1.0);
      }
    `

    const compileShader = (type, src) => {
      const sh = gl.createShader(type)
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        gl.deleteShader(sh)
        return null
      }
      return sh
    }

    const vs = compileShader(gl.VERTEX_SHADER, vertexSource)
    const fs = compileShader(gl.FRAGMENT_SHADER, fragmentSource)
    if (!vs || !fs) return

    const program = gl.createProgram()
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    )

    const aPos = gl.getAttribLocation(program, 'a_position')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uRes = gl.getUniformLocation(program, 'u_resolution')
    const uMouse = gl.getUniformLocation(program, 'u_mouse')
    const uTime = gl.getUniformLocation(program, 'u_time')
    const uMode = gl.getUniformLocation(program, 'u_mode')

    let mouseX = window.innerWidth * 0.5
    let mouseY = window.innerHeight * 0.5
    let targetX = mouseX
    let targetY = mouseY
    let interpMode = modeValueRef.current
    let active = true
    let rafId = 0

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      gl.viewport(0, 0, canvas.width, canvas.height)
    }
    resize()

    const onMouseMove = (e) => {
      targetX = e.clientX
      targetY = e.clientY
    }
    const onTouchMove = (e) => {
      if (e.touches.length > 0) {
        targetX = e.touches[0].clientX
        targetY = e.touches[0].clientY
      }
    }
    const onVis = () => {
      active = !document.hidden
      if (active && !rafId) rafId = requestAnimationFrame(loop)
    }

    window.addEventListener('resize', resize)
    window.addEventListener('mousemove', onMouseMove, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    document.addEventListener('visibilitychange', onVis)

    const start = performance.now()
    const loop = (now) => {
      if (!active) {
        rafId = 0
        return
      }
      mouseX += (targetX - mouseX) * 0.08
      mouseY += (targetY - mouseY) * 0.08
      interpMode += (modeValueRef.current - interpMode) * 0.06

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      gl.useProgram(program)
      gl.uniform2f(uRes, canvas.width, canvas.height)
      gl.uniform2f(uMouse, mouseX * dpr, mouseY * dpr)
      gl.uniform1f(uTime, (now - start) * 0.001)
      gl.uniform1f(uMode, interpMode)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      rafId = requestAnimationFrame(loop)
    }
    rafId = requestAnimationFrame(loop)

    return () => {
      active = false
      if (rafId) cancelAnimationFrame(rafId)
      window.removeEventListener('resize', resize)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('touchmove', onTouchMove)
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])

  return (
    <>
      <canvas ref={canvasRef} className="landing-shader-canvas" aria-hidden="true" />
      <div className="landing-grain-overlay" aria-hidden="true" />
    </>
  )
}
