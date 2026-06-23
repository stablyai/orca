export type TerminalWebglAutoDecision = {
  allowWebgl: boolean
  reason:
    | 'non-linux'
    | 'linux-hardware-renderer'
    | 'linux-webgl2-unavailable'
    | 'linux-renderer-unavailable'
    | 'linux-software-renderer'
  renderer: string | null
  vendor: string | null
}

let cachedDecision: TerminalWebglAutoDecision | null = null

const LINUX_SOFTWARE_RENDERER_PATTERN =
  /\b(swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|basic render|virgl|svga3d)\b/i

export function resetTerminalWebglAutoDecision(): void {
  cachedDecision = null
}

export function isLinuxRendererHost(
  platform: string = typeof navigator === 'undefined' ? '' : navigator.platform,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  if (userAgent.startsWith('Node.js/')) {
    return false
  }
  return platform.includes('Linux') || userAgent.includes('Linux')
}

function readWebglRendererInfo(): Pick<TerminalWebglAutoDecision, 'renderer' | 'vendor'> & {
  hasWebgl2: boolean
  hasRendererInfo: boolean
} {
  if (typeof document === 'undefined') {
    return { hasWebgl2: false, hasRendererInfo: false, renderer: null, vendor: null }
  }

  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) {
      return { hasWebgl2: false, hasRendererInfo: false, renderer: null, vendor: null }
    }

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info')
    if (!debugInfo) {
      return { hasWebgl2: true, hasRendererInfo: false, renderer: null, vendor: null }
    }

    const renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '')
    const vendor = String(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL) ?? '')
    return {
      hasWebgl2: true,
      hasRendererInfo: renderer.length > 0 || vendor.length > 0,
      renderer: renderer || null,
      vendor: vendor || null
    }
  } catch {
    return { hasWebgl2: false, hasRendererInfo: false, renderer: null, vendor: null }
  }
}

export function getTerminalWebglAutoDecision(): TerminalWebglAutoDecision {
  if (cachedDecision) {
    return cachedDecision
  }

  if (!isLinuxRendererHost()) {
    cachedDecision = {
      allowWebgl: true,
      reason: 'non-linux',
      renderer: null,
      vendor: null
    }
    return cachedDecision
  }

  const rendererInfo = readWebglRendererInfo()
  if (!rendererInfo.hasWebgl2) {
    cachedDecision = {
      allowWebgl: false,
      reason: 'linux-webgl2-unavailable',
      renderer: rendererInfo.renderer,
      vendor: rendererInfo.vendor
    }
    return cachedDecision
  }

  if (!rendererInfo.hasRendererInfo) {
    // Why: the Linux corruption path can leave WebGL alive while glyphs are bad;
    // without renderer identity we cannot distinguish hardware from software GL.
    cachedDecision = {
      allowWebgl: false,
      reason: 'linux-renderer-unavailable',
      renderer: rendererInfo.renderer,
      vendor: rendererInfo.vendor
    }
    return cachedDecision
  }

  const identity = `${rendererInfo.vendor ?? ''} ${rendererInfo.renderer ?? ''}`
  if (LINUX_SOFTWARE_RENDERER_PATTERN.test(identity)) {
    cachedDecision = {
      allowWebgl: false,
      reason: 'linux-software-renderer',
      renderer: rendererInfo.renderer,
      vendor: rendererInfo.vendor
    }
    return cachedDecision
  }

  cachedDecision = {
    allowWebgl: true,
    reason: 'linux-hardware-renderer',
    renderer: rendererInfo.renderer,
    vendor: rendererInfo.vendor
  }
  return cachedDecision
}
