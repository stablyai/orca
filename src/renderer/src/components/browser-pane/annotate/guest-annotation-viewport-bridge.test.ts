import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAnnotation } from '@/store/slices/browser-annotation-test-fixture'
import type { BrowserSetAnnotationViewportBridgeArgs } from '../../../../../shared/browser-annotation-viewport-bridge'
import { syncGuestAnnotationViewportBridge } from './guest-annotation-viewport-bridge'

afterEach(() => vi.unstubAllGlobals())

function createBridge() {
  const setAnnotationViewportBridge = vi
    .fn<(args: BrowserSetAnnotationViewportBridgeArgs) => Promise<void>>()
    .mockResolvedValue(undefined)
  vi.stubGlobal('window', { api: { browser: { setAnnotationViewportBridge } } })
  const notes = [makeAnnotation('page-1', 'old'), makeAnnotation('page-1', 'fresh')]
  return { setAnnotationViewportBridge, notes }
}

describe('current-document annotation marker projection', () => {
  it('requires both eligible geometry and the captured URL while retaining global tray indices', () => {
    const { setAnnotationViewportBridge, notes } = createBridge()
    syncGuestAnnotationViewportBridge({
      toolTargetId: 'page-1',
      annotations: notes,
      currentDocument: { markerIds: ['fresh'], url: 'https://example.com/?private=query#fragment' },
      pendingPayload: null,
      surfaceActive: true,
      token: 'token'
    })
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        emitViewport: false,
        markers: [expect.objectContaining({ id: 'fresh', index: 1 })]
      })
    )
    syncGuestAnnotationViewportBridge({
      toolTargetId: 'page-1',
      annotations: notes,
      currentDocument: { markerIds: ['fresh'], url: 'https://example.com/next' },
      pendingPayload: null,
      surfaceActive: true,
      token: 'token'
    })
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, markers: [] })
    )
  })

  it('does not resurrect old same-URL geometry on dom-ready or return, but permits pending viewport events', () => {
    const { setAnnotationViewportBridge, notes } = createBridge()
    const args = {
      toolTargetId: 'page-1',
      annotations: notes,
      currentDocument: { markerIds: [], url: 'https://example.com' },
      pendingPayload: null,
      surfaceActive: true,
      token: 'token'
    }
    syncGuestAnnotationViewportBridge(args)
    syncGuestAnnotationViewportBridge(args)
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, markers: [] })
    )
    syncGuestAnnotationViewportBridge({ ...args, pendingPayload: notes[1].payload })
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, emitViewport: true, markers: [] })
    )
    syncGuestAnnotationViewportBridge({
      ...args,
      pendingPayload: notes[1].payload,
      surfaceActive: false
    })
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false })
    )
  })

  it('preserves the document-preview caller when no browsing projection is supplied', () => {
    const { setAnnotationViewportBridge, notes } = createBridge()
    syncGuestAnnotationViewportBridge({
      toolTargetId: 'reminted-preview',
      annotations: notes,
      pendingPayload: null,
      surfaceActive: true,
      token: 'token'
    })
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        browserPageId: 'reminted-preview',
        enabled: true,
        markers: [
          expect.objectContaining({ id: 'old', index: 0 }),
          expect.objectContaining({ id: 'fresh', index: 1 })
        ]
      })
    )
  })

  it('tolerates a destroyed guest without retaining or throwing a rejected bridge call', async () => {
    const { setAnnotationViewportBridge, notes } = createBridge()
    setAnnotationViewportBridge.mockRejectedValueOnce(new Error('Guest destroyed'))
    expect(() =>
      syncGuestAnnotationViewportBridge({
        toolTargetId: 'page-1',
        annotations: notes,
        currentDocument: { markerIds: [], url: 'https://example.com' },
        pendingPayload: null,
        surfaceActive: true,
        token: 'token'
      })
    ).not.toThrow()
    await Promise.resolve()
  })
})
