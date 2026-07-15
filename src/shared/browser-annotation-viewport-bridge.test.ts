// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_ANNOTATION_MARKERS_MESSAGE_PREFIX,
  buildBrowserAnnotationViewportBridgeScript
} from './browser-annotation-viewport-bridge'

describe('browser annotation viewport bridge disable path', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    document.body.innerHTML = ''
    delete (window as typeof window & { __orcaBrowserAnnotationViewportBridge?: unknown })
      .__orcaBrowserAnnotationViewportBridge
  })

  it('clears emitted marker ids and removes the existing overlay when disabled', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    ;(
      window as typeof window & {
        __orcaBrowserAnnotationViewportBridge?: {
          host: HTMLDivElement
          markerElements: Map<string, HTMLSpanElement>
          markers: unknown[]
          raf: number
          requestUpdate: () => void
          shadowRoot: null
        }
      }
    ).__orcaBrowserAnnotationViewportBridge = {
      host,
      markerElements: new Map(),
      markers: [],
      raf: 0,
      requestUpdate: () => {},
      shadowRoot: null
    }
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})

    const script = buildBrowserAnnotationViewportBridgeScript({
      enabled: false,
      emitViewport: false,
      markers: [],
      token: 'abcdefghijklmnop'
    })

    expect(() => window.eval(script)).not.toThrow()
    expect(debugSpy).toHaveBeenCalledWith(
      `${BROWSER_ANNOTATION_MARKERS_MESSAGE_PREFIX}abcdefghijklmnop:[]`
    )
    expect(document.body.contains(host)).toBe(false)
    expect(
      (window as typeof window & { __orcaBrowserAnnotationViewportBridge?: unknown })
        .__orcaBrowserAnnotationViewportBridge
    ).toBeUndefined()
  })
})
