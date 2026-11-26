// @vitest-environment happy-dom
// A window reloaded (or closed) while a reopened chip's viewer is open lets go of its edit claim,
// so where there are no Web Locks to show the claim was abandoned (Remote Web over plain HTTP), no
// other window holds the chip's Send, Remove or Clear for the claim's full ten minutes.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { markNativeChatNotedImageEditing } from './native-chat-chip-notes'

const SCOPE = 'agent-session:reload'
const PREFIX = `orca.nativeChat.notesEditing.v2:${encodeURIComponent(`${SCOPE}\u0000chip`)}:`
const markers = (): string[] => Object.keys(localStorage).filter((item) => item.startsWith(PREFIX))

beforeEach(() => {
  localStorage.clear()
  // No Web Locks, as on a page served over plain HTTP.
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: undefined })
})
afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, 'locks')
})

it('a reload without Web Locks lets go of the edit claim the open viewer held', async () => {
  const otherWindow = new BroadcastChannel('orca-native-chat-notes-edit')
  const heard: unknown[] = []
  otherWindow.onmessage = (event) => heard.push(event.data)
  // The reopened chip's viewer is open, as its chip marks it.
  markNativeChatNotedImageEditing(SCOPE, 'chip')
  expect(markers()).toHaveLength(1)
  // The window reloads with the viewer still open: its editor never closes.
  window.dispatchEvent(new Event('pagehide'))
  expect(markers()).toEqual([])
  await vi.waitFor(() => expect(heard).toContainEqual(expect.objectContaining({ type: 'release' })))
  otherWindow.close()
})
