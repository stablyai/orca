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
}: MockWebglRendererInfo): void {
  const rendererKey = 0x9246
  const vendorKey = 0x9245
  const gl = {
    getExtension: vi.fn(() =>
      hasDebugInfo
        ? {
            UNMASKED_RENDERER_WEBGL: rendererKey,
            UNMASKED_VENDOR_WEBGL: vendorKey
          }
        : null
    ),
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

  vi.stubGlobal('document', {
    createElement: vi.fn((tagName: string) => {
      if (tagName === 'canvas') {
        return {
          getContext: vi.fn((contextName: string) =>
            hasWebgl2 && contextName === 'webgl2' ? gl : null
          )
        }
      }
      return {}
    })
  })
}

function stubNoDocument(): void {
  vi.stubGlobal('document', undefined)
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
