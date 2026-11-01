import { describe, expect, it, vi } from 'vitest'
import { nativeChatComposerSendState } from './native-chat-composer-send-state'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

const transport: NativeChatStructuredComposerTransport = {
  capturePresentation: () => () => true,
  send: vi.fn(),
  dispatchCommand: vi.fn(),
  optionsSurface: {
    getSnapshot: () => [],
    subscribe: () => () => {},
    invokeAction: async () => ({ snapshot: [] }),
    setOption: async () => ({ snapshot: [] })
  },
  optionSnapshot: [],
  onError: vi.fn(),
  runtime: 'local',
  sessionId: 'session',
  runtimeEnvironmentId: null,
  promptSuggestion: 'add a test'
}

function state(overrides: Partial<Parameters<typeof nativeChatComposerSendState>[0]> = {}) {
  return nativeChatComposerSendState({
    draft: '',
    messageDelivery: true,
    imageAttachments: [],
    pastedTextSaving: false,
    disabled: false,
    structuredTransport: transport,
    editSession: undefined,
    isWorking: false,
    canStop: true,
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    ...overrides
  })
}

describe('native chat composer prompt suggestion', () => {
  it('offers the suggestion only to an empty composer that would send a plain message', () => {
    expect(state().promptSuggestion?.text).toBe('add a test')
    for (const blocked of [
      { draft: 'fix it' },
      { messageDelivery: false },
      { disabled: true },
      { pastedTextSaving: true },
      { imageAttachments: [{ id: 'image', path: '/tmp/shot.png' }] },
      { editSession: { canSave: true } }
    ]) {
      expect(state(blocked).promptSuggestion).toBeNull()
    }
  })

  it('accepts into the draft with the caret at its end', () => {
    const setDraft = vi.fn()
    const setCaret = vi.fn()
    state({ setDraft, setCaret }).promptSuggestion?.accept()
    expect(setDraft).toHaveBeenCalledWith('add a test')
    expect(setCaret).toHaveBeenCalledWith('add a test'.length)
  })
})
