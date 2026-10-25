import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => vi.unstubAllGlobals())

it('imports without browser storage and keeps an undefined scope stable and inactive', async () => {
  vi.stubGlobal('localStorage', undefined)
  const { getNativeChatAnnotationsStore } = await import('./native-chat-annotations-store')
  const store = getNativeChatAnnotationsStore(undefined)
  const snapshot = store.getSnapshot()
  const listener = vi.fn()
  const unsubscribe = store.subscribe(listener)
  expect(getNativeChatAnnotationsStore(undefined)).toBe(store)
  expect(store.add({ quote: 'words', messageId: 'reply', startOffset: 0 }, 'comment')).toBeNull()
  expect(store.update('id', 'comment')).toBe(false)
  expect(store.remove('id')).toBe(false)
  expect(
    store.setEditor({
      anchor: { quote: 'words', messageId: 'reply', startOffset: 0 },
      comment: 'draft'
    })
  ).toBe(false)
  expect(store.setEditor(undefined)).toBe(false)
  expect(store.clear()).toBe(false)
  expect(store.retryPersistence()).toBe(false)
  expect(store.getSnapshot()).toBe(snapshot)
  expect(snapshot).toEqual({ notes: [] })
  expect(listener).not.toHaveBeenCalled()
  unsubscribe()
})
