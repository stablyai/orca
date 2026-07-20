import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getTerminalWebglAutoDecision,
  isLinuxRendererHost,
  resetTerminalWebglAutoDecision
} from './terminal-webgl-auto-policy'

type MockWebglRendererInfo = {
  renderer?: string | null
  vendor?: string | null
  hasWebgl2?: boolean
  hasDebugInfo?: boolean
}

function stubNavigator(platform: string, userAgent: string): void {
  vi.stubGlobal('navigator', { platform, userAgent })
}

function stubWebglRendererInfo({
  renderer = 'Mesa Intel(R) Graphics',
  vendor = 'Intel',
  hasWebgl2 = true,
  hasDebugInfo = true
}: MockWebglRendererInfo): {
  canvas: { width: number; height: number }
  loseContext: ReturnType<typeof vi.fn>
} {
  const rendererKey = 0x9246
  const vendorKey = 0x9245
  const loseContext = vi.fn()
  const gl = {
    getExtension: vi.fn((extensionName: string) => {
      if (extensionName === 'WEBGL_lose_context') {
        return { loseContext }
      }
      if (extensionName !== 'WEBGL_debug_renderer_info' || !hasDebugInfo) {
        return null
      }
      return {
        UNMASKED_RENDERER_WEBGL: rendererKey,
        UNMASKED_VENDOR_WEBGL: vendorKey
      }
    }),
    getParameter: vi.fn((key: number) => {
      if (key === rendererKey) {
        return renderer
      }
      if (key === vendorKey) {
        return vendor
      }
      return null
    })
  }
  const canvas = {
    width: 300,
    height: 150,
    getContext: vi.fn((contextName: string) => (hasWebgl2 && contextName === 'webgl2' ? gl : null))
  }

  vi.stubGlobal('document', {
    createElement: vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return canvas
      }
      return {}
    })
  })
  return { canvas, loseContext }
}

function stubNoDocument(): void {
  vi.stubGlobal('document', undefined)
}

function stubDisplayServer(displayServer: 'wayland' | 'x11' | null): void {
  vi.stubGlobal('window', {
    api: {
      platform: {
        get: () => ({
          platform: 'linux',
          osRelease: '',
          displayServer
        })
      }
    }
  })
}

describe('terminal WebGL auto policy', () => {
  beforeEach(() => {
    resetTerminalWebglAutoDecision()
  })

  afterEach(() => {
    resetTerminalWebglAutoDecision()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('detects Linux hosts from platform or user agent', () => {
    expect(isLinuxRendererHost('Linux x86_64', 'Mozilla/5.0')).toBe(true)
    expect(isLinuxRendererHost('MacIntel', 'Mozilla/5.0 (X11; Linux x86_64)')).toBe(true)
    expect(isLinuxRendererHost('MacIntel', 'Mozilla/5.0 (Macintosh)')).toBe(false)
    expect(isLinuxRendererHost('Linux x86_64', 'Node.js/24')).toBe(false)
  })

  it('allows non-Linux auto panes to try WebGL without probing renderer identity', () => {
    stubNavigator('MacIntel', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
    stubNoDocument()

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: true,
      reason: 'non-linux'
    })
  })

  it.each([
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))'],
    ['ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)'],
    ['ANGLE (Microsoft, D3D11 WARP Direct3D11 vs_5_0 ps_5_0)']
  ])('keeps Windows auto panes on DOM for software renderer %s', (renderer) => {
    stubNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    stubWebglRendererInfo({ renderer, vendor: 'Google Inc. (Microsoft)' })

    expect(getTerminalWebglAutoDecision()).toEqual({
      allowWebgl: false,
      reason: 'non-linux-software-renderer',
      renderer,
      vendor: 'Google Inc. (Microsoft)'
    })
  })

  it('keeps Windows auto panes on DOM when WebGL2 is unavailable', () => {
    stubNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    const probe = stubWebglRendererInfo({ hasWebgl2: false })

    expect(getTerminalWebglAutoDecision()).toEqual({
      allowWebgl: false,
      reason: 'non-linux-webgl2-unavailable',
      renderer: null,
      vendor: null
    })
    expect(probe.loseContext).not.toHaveBeenCalled()
    expect(probe.canvas.width).toBe(0)
    expect(probe.canvas.height).toBe(0)
  })

  it('allows Windows auto panes for identifiable hardware renderers', () => {
    stubNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    stubWebglRendererInfo({
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
      vendor: 'Google Inc. (NVIDIA)'
    })

    expect(getTerminalWebglAutoDecision()).toEqual({
      allowWebgl: true,
      reason: 'non-linux',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0)',
      vendor: 'Google Inc. (NVIDIA)'
    })
  })

  it('releases the renderer identity probe context', () => {
    stubNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
    const probe = stubWebglRendererInfo({
      renderer: 'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0)',
      vendor: 'Google Inc. (Microsoft)'
    })

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: false,
      reason: 'non-linux-software-renderer'
    })
    expect(probe.loseContext).toHaveBeenCalledTimes(1)
    expect(probe.canvas.width).toBe(0)
    expect(probe.canvas.height).toBe(0)
  })

  it('allows Linux auto panes for identifiable hardware renderers', () => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({
      renderer: 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)',
      vendor: 'Intel'
    })

    expect(getTerminalWebglAutoDecision()).toEqual({
      allowWebgl: true,
      reason: 'linux-hardware-renderer',
      renderer: 'Mesa Intel(R) UHD Graphics 770 (ADL-S GT1)',
      vendor: 'Intel'
    })
  })

  it('keeps Linux auto panes on DOM for Wayland before probing WebGL', () => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubDisplayServer('wayland')
    stubNoDocument()

    expect(getTerminalWebglAutoDecision()).toEqual({
      allowWebgl: false,
      reason: 'linux-wayland',
      renderer: null,
      vendor: null
    })
  })

  it('keeps Linux auto panes on DOM when WebGL2 is unavailable', () => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({ hasWebgl2: false })

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: false,
      reason: 'linux-webgl2-unavailable'
    })
  })

  it('keeps Linux auto panes on DOM when renderer identity is hidden', () => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({ hasDebugInfo: false })

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: false,
      reason: 'linux-renderer-unavailable'
    })
  })

  it.each([
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)))'],
    ['llvmpipe (LLVM 17.0.6, 256 bits)'],
    ['softpipe'],
    ['Mesa X11 Software Rasterizer'],
    ['SVGA3D; build: RELEASE; LLVM;']
  ])('keeps Linux auto panes on DOM for software renderer %s', (renderer) => {
    stubNavigator('Linux x86_64', 'Mozilla/5.0 (X11; Linux x86_64)')
    stubWebglRendererInfo({ renderer, vendor: 'Mesa/X.org' })

    expect(getTerminalWebglAutoDecision()).toMatchObject({
      allowWebgl: false,
      reason: 'linux-software-renderer',
      renderer
    })
  })
})
