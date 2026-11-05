// Input while visibilityState is stuck hidden must recover each pane once; genuine visibilitychange restores tracker authority.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as StaleDocumentVisibility from './stale-document-visibility'

type Handler = () => void

type EventTargetStub = {
  addEventListener: (type: string, handler: Handler, options?: unknown) => void
  removeEventListener: (type: string, handler: Handler, options?: unknown) => void
  emit: (type: string) => void
  listenerCount: (type: string) => number
}

function createEventTargetStub(): EventTargetStub {
  const listeners = new Map<string, Set<Handler>>()
  return {
    addEventListener(type, handler) {
      const set = listeners.get(type) ?? new Set()
      set.add(handler)
      listeners.set(type, set)
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler)
    },
    emit(type) {
      for (const handler of listeners.get(type) ?? []) {
        handler()
      }
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0
    }
  }
}

type DocumentStub = EventTargetStub & { visibilityState: string }

describe('stale document visibility', () => {
  const originalDocument = (globalThis as { document?: unknown }).document
  const originalWindow = (globalThis as { window?: unknown }).window
  let documentStub: DocumentStub
  let windowStub: EventTargetStub
  let warnSpy: ReturnType<typeof vi.spyOn>
  let mod: typeof StaleDocumentVisibility

  beforeEach(async () => {
    vi.resetModules()
    documentStub = { ...createEventTargetStub(), visibilityState: 'visible' }
    windowStub = createEventTargetStub()
    ;(globalThis as { document: unknown }).document = documentStub
    ;(globalThis as { window: unknown }).window = windowStub
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mod = await import('./stale-document-visibility')
  })

  afterEach(() => {
    mod.resetStaleDocumentVisibilityForTesting()
    warnSpy.mockRestore()
    ;(globalThis as { document: unknown }).document = originalDocument
    ;(globalThis as { window: unknown }).window = originalWindow
  })

  it('latches the override and runs recovery once when input arrives while hidden', () => {
    const recovery = vi.fn()
    mod.registerStaleDocumentVisibilityRecovery(recovery)
    documentStub.visibilityState = 'hidden'

    documentStub.emit('keydown')
    expect(mod.isDocumentVisibilityProvenStale()).toBe(true)
    expect(recovery).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledTimes(1)

    documentStub.emit('keydown')
    documentStub.emit('pointerdown')
    expect(recovery).toHaveBeenCalledTimes(1)
  })

  it('hands authority back to the occlusion tracker on a genuine visibilitychange', () => {
    const recovery = vi.fn()
    mod.registerStaleDocumentVisibilityRecovery(recovery)
    documentStub.visibilityState = 'hidden'
    documentStub.emit('keydown')
    expect(mod.isDocumentVisibilityProvenStale()).toBe(true)

    documentStub.visibilityState = 'visible'
    documentStub.emit('visibilitychange')
    expect(mod.isDocumentVisibilityProvenStale()).toBe(false)

    documentStub.visibilityState = 'hidden'
    documentStub.emit('keydown')
    expect(mod.isDocumentVisibilityProvenStale()).toBe(true)
    expect(recovery).toHaveBeenCalledTimes(2)
  })

  it('removes global listeners when the last pane unregisters', () => {
    const unregisterA = mod.registerStaleDocumentVisibilityRecovery(vi.fn())
    const unregisterB = mod.registerStaleDocumentVisibilityRecovery(vi.fn())
    expect(documentStub.listenerCount('keydown')).toBe(1)

    unregisterA()
    expect(documentStub.listenerCount('keydown')).toBe(1)
    unregisterB()
    expect(documentStub.listenerCount('keydown')).toBe(0)
    expect(documentStub.listenerCount('pointerdown')).toBe(0)
    expect(documentStub.listenerCount('visibilitychange')).toBe(0)
    expect(windowStub.listenerCount('focus')).toBe(0)

    mod.registerStaleDocumentVisibilityRecovery(vi.fn())
    expect(documentStub.listenerCount('keydown')).toBe(1)
  })
})
