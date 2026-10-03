// @vitest-environment happy-dom
// The web client keeps its drafts in this browser, never on the runtime it is paired with.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeResultMock, getClientForEnvironmentMock } = vi.hoisted(() => ({
  callRuntimeResultMock: vi.fn(),
  getClientForEnvironmentMock: vi.fn()
}))

vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: callRuntimeResultMock }))
vi.mock('./web-runtime-session', () => ({
  getClientForEnvironment: getClientForEnvironmentMock,
  requireActiveEnvironmentOrNull: vi.fn(() => null)
}))

import { createWebNativeChatApi } from './web-native-chat-api'

const PREFIX = 'orca:nativeChatComposerDraft:v1:'
const draft = { text: 'half typed', attachments: [] }

beforeEach(() => localStorage.clear())

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('web client drafts', () => {
  it('saves, loads and clears drafts in browser storage only', async () => {
    const { drafts } = createWebNativeChatApi()

    await expect(drafts.write('session:s1', draft)).resolves.toBe('persisted')
    expect(
      JSON.parse(localStorage.getItem(`${PREFIX}${encodeURIComponent('session:s1')}`) ?? 'null')
    ).toMatchObject(draft)
    expect(await drafts.load()).toEqual([{ scopeKey: 'session:s1', draft }])
    expect(drafts.loadSync()).toEqual([{ scopeKey: 'session:s1', draft }])

    await drafts.write('session:s1', null)
    expect(localStorage.length).toBe(0)
    expect(callRuntimeResultMock).not.toHaveBeenCalled()
    expect(getClientForEnvironmentMock).not.toHaveBeenCalled()
  })

  it('reports a write the browser refused', async () => {
    vi.stubGlobal('localStorage', {
      ...localStorage,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError')
      }
    })

    await expect(createWebNativeChatApi().drafts.write('session:s1', draft)).resolves.toBe('failed')
  })

  // Blocked site storage is a setting, not an error.
  it('reports no storage, rather than a failure, when the browser has none', async () => {
    vi.stubGlobal('localStorage', undefined)

    await expect(createWebNativeChatApi().drafts.write('session:s1', draft)).resolves.toBe(
      'unavailable'
    )
  })

  it("hears another tab's change to a draft", () => {
    const listener = vi.fn()
    createWebNativeChatApi().drafts.onExternalChange?.(listener)

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: `${PREFIX}${encodeURIComponent('pane:tab-1:leaf-1')}`,
        newValue: JSON.stringify({ ...draft, savedAt: 1 })
      })
    )
    window.dispatchEvent(
      new StorageEvent('storage', { key: `${PREFIX}${encodeURIComponent('session:s1')}` })
    )

    expect(listener.mock.calls).toEqual([
      ['pane:tab-1:leaf-1', draft],
      ['session:s1', null]
    ])
  })
})
