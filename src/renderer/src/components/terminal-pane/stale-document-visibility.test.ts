// Why: pins the stale-occlusion proof — user input while
// document.visibilityState claims 'hidden' must latch the override and run
// each pane's recovery exactly once, and a genuine visibilitychange must hand
// authority back to the occlusion tracker.
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

    // Further input during the same stuck episode must not re-run recovery.
    documentStub.emit('keydown')
    documentStub.emit('pointerdown')
    expect(recovery).toHaveBeenCalledTimes(1)
  })

  it('does not latch while the document is genuinely visible', () => {
    const recovery = vi.fn()
    mod.registerStaleDocumentVisibilityRecovery(recovery)

    documentStub.emit('keydown')
    documentStub.emit('pointerdown')
    windowStub.emit('focus')
    expect(mod.isDocumentVisibilityProvenStale()).toBe(false)
    expect(recovery).not.toHaveBeenCalled()
  })

  it('treats pointerdown and window focus as staleness proof too', () => {
    const recovery = vi.fn()
    mod.registerStaleDocumentVisibilityRecovery(recovery)
    documentStub.visibilityState = 'hidden'

    documentStub.emit('pointerdown')
    expect(mod.isDocumentVisibilityProvenStale()).toBe(true)

    mod.resetStaleDocumentVisibilityForTesting()
    mod.registerStaleDocumentVisibilityRecovery(recovery)
    documentStub.visibilityState = 'hidden'
    windowStub.emit('focus')
    expect(mod.isDocumentVisibilityProvenStale()).toBe(true)
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

    // A fresh wedge after trust was restored must latch (and recover) again.
    documentStub.visibilityState = 'hidden'
    documentStub.emit('keydown')
    expect(mod.isDocumentVisibilityProvenStale()).toBe(true)
    expect(recovery).toHaveBeenCalledTimes(2)
  })

  it('keeps running other panes when one recovery listener throws', () => {
    const throwing = vi.fn(() => {
      throw new Error('pane exploded')
    })
    const healthy = vi.fn()
    mod.registerStaleDocumentVisibilityRecovery(throwing)
    mod.registerStaleDocumentVisibilityRecovery(healthy)
    documentStub.visibilityState = 'hidden'

    documentStub.emit('keydown')
    expect(throwing).toHaveBeenCalledTimes(1)
    expect(healthy).toHaveBeenCalledTimes(1)
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

    // Re-registering must reinstall for a later pane.
    mod.registerStaleDocumentVisibilityRecovery(vi.fn())
    expect(documentStub.listenerCount('keydown')).toBe(1)
  })
})
