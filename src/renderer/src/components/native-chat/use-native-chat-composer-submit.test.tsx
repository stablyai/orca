// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'

import {
  clearNativeChatDraftCacheForTests,
  readNativeChatDraftCache,
  writeNativeChatDraftCache
} from './native-chat-draft-cache'

const SCOPE = 'tab-1:pane'

afterEach(() => {
  clearNativeChatDraftCacheForTests()
})

const GOAL_ITEM: NativeChatPickerItem = {
  kind: 'command',
  id: 'goal',
  name: 'goal',
  token: '/goal',
  skillCollision: false
}
// Claude's initialize descriptor marks its own goal `builtin: true`; a user skill named goal replaces it unmarked.

function harness(options: {
  draft: string
  caret?: number
  threadGoal?: NativeChatStructuredComposerTransport['threadGoal']
  imageAttachments?: NativeChatComposerImageAttachment[]
  nativeAdmission?: boolean | 'queued'
  lane?: 'pty'
  submitEmpty?: () => void
  capturePresentation?: NativeChatStructuredComposerTransport['capturePresentation']
}) {
  const onError = vi.fn()
  const onSubmitted = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this fixture provides the submit and native-send paths it exercises.
  const structuredTransport = {
    capturePresentation: options.capturePresentation ?? (() => () => true),
    onError,
    onSubmitted,
    send: vi.fn(() => options.nativeAdmission ?? true),
    dispatchCommand: vi.fn(async () => ({ handled: false, accepted: false, error: null })),
    ...(options.threadGoal ? { threadGoal: options.threadGoal } : {})
  } as unknown as NativeChatStructuredComposerTransport
  const calls = {
    sendPty: vi.fn(),
    sendStructured: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn()
  }
  writeNativeChatDraftCache(SCOPE, options.draft)
  const hook = renderHook(
    (props: { draft: string; caret: number }) => {
      const nativeSend = useNativeChatStructuredComposerSend({
        agent: 'claude',
        draftScopeKey: SCOPE,
        imageAttachments: [],
        structuredTransport,
        isComposing: () => false,
        clearSkillOrigin: vi.fn(),
        setDraft: (value) => writeNativeChatDraftCache(SCOPE, value),
        setCaret: calls.setCaret
      })
      return useNativeChatComposerSubmit({
        structuredTransport: options.lane === 'pty' ? undefined : structuredTransport,
        draftScopeKey: SCOPE,
        draft: props.draft,
        caret: props.caret,
        imageAttachments: options.imageAttachments ?? [],
        disabled: false,
        submitEmpty: options.submitEmpty,
        ...calls,
        sendStructured: options.nativeAdmission !== undefined ? nativeSend : calls.sendStructured
      })
    },
    { initialProps: { draft: options.draft, caret: options.caret ?? options.draft.length } }
  )
  const type = (draft: string, caret: number): void => {
    writeNativeChatDraftCache(SCOPE, draft)
    hook.rerender({ draft, caret })
  }
  return { hook, calls, onError, onSubmitted, type, structuredTransport }
}

describe('composer goal mode', () => {
  it('sets the draft as the goal instead of sending it, then leaves goal mode', async () => {
    const setObjective = vi.fn(async () => true)
    const { hook, calls, onSubmitted, type } = harness({
      draft: '/go',
      threadGoal: { setObjective }
    })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    type('  Ship the parser  ', 0)

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledWith('Ship the parser')
    expect(onSubmitted).toHaveBeenCalledOnce()
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(hook.result.current.goalMode.active).toBe(false)
  })

  it('keeps a draft edited while the goal was in flight, and stays in goal mode', async () => {
    let settle: (accepted: boolean) => void = () => undefined
    const setObjective = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)))
    const { hook, calls, type } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    type('Ship the parser', 0)
    calls.setDraft.mockClear()

    act(() => hook.result.current.send())
    type('Ship the parser and its tests', 0)
    await act(async () => settle(true))

    expect(setObjective).toHaveBeenCalledWith('Ship the parser')
    expect(readNativeChatDraftCache(SCOPE)).toBe('Ship the parser and its tests')
    expect(hook.result.current.goalMode.active).toBe(true)
  })

  it('consumes an accepted captured goal after closure without touching local controls', async () => {
    const reply = Promise.withResolvers<boolean>()
    let current = true
    const { hook, calls, type, onError } = harness({
      draft: '/go',
      threadGoal: { setObjective: () => reply.promise },
      capturePresentation: () => () => current
    })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    type('Ship it', 0)
    act(() => hook.result.current.send())
    calls.setCaret.mockClear()
    hook.unmount()
    current = false
    await act(async () => reply.resolve(true))
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(calls.setCaret).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })
})
