// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatPickerItem } from './native-chat-picker-items'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
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
const MODEL_ITEM: NativeChatPickerItem = {
  ...GOAL_ITEM,
  id: 'model',
  name: 'model',
  token: '/model'
}

function harness(options: {
  draft: string
  caret?: number
  threadGoal?: NativeChatStructuredComposerTransport['threadGoal']
  imageAttachments?: NativeChatComposerImageAttachment[]
  /** The PTY lane has no structured transport at all. */
  lane?: 'pty'
}) {
  const onError = vi.fn()
  const onSubmitted = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: submit reads only threadGoal, onError and onSubmitted.
  const structuredTransport = {
    onError,
    onSubmitted,
    ...(options.threadGoal ? { threadGoal: options.threadGoal } : {})
  } as unknown as NativeChatStructuredComposerTransport
  const calls = {
    sendPty: vi.fn(),
    sendStructured: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    setHistory: vi.fn()
  }
  writeNativeChatDraftCache(SCOPE, options.draft)
  const hook = renderHook(
    (props: { draft: string; caret: number }) =>
      useNativeChatComposerSubmit({
        structuredTransport: options.lane === 'pty' ? undefined : structuredTransport,
        draftScopeKey: SCOPE,
        draft: props.draft,
        caret: props.caret,
        imageAttachments: options.imageAttachments ?? [],
        disabled: false,
        ...calls
      }),
    { initialProps: { draft: options.draft, caret: options.caret ?? options.draft.length } }
  )
  /** The user's typing: the draft store and the rendered draft move together. */
  const type = (draft: string, caret: number): void => {
    writeNativeChatDraftCache(SCOPE, draft)
    hook.rerender({ draft, caret })
  }
  return { hook, calls, onError, onSubmitted, type }
}

describe('composer goal mode', () => {
  it('enters goal mode on a /goal pick and drops the token from the draft', () => {
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective: vi.fn() } })
    const pick = vi.fn()

    act(() => hook.result.current.goalMode.interceptPick(pick)(GOAL_ITEM))

    expect(pick).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenCalledWith('')
    expect(calls.setCaret).toHaveBeenCalledWith(0)
    expect(hook.result.current.goalMode.active).toBe(true)

    act(() => hook.result.current.goalMode.exit())
    expect(hook.result.current.goalMode.active).toBe(false)
  })

  it('leaves other picks, and /goal on a host without goals, to the picker', () => {
    const withGoals = harness({ draft: '/mo', threadGoal: { setObjective: vi.fn() } })
    const pick = vi.fn()
    act(() => withGoals.hook.result.current.goalMode.interceptPick(pick)(MODEL_ITEM))
    expect(pick).toHaveBeenCalledWith(MODEL_ITEM)

    const withoutGoals = harness({ draft: '/go' })
    act(() => withoutGoals.hook.result.current.goalMode.interceptPick(pick)(GOAL_ITEM))
    expect(pick).toHaveBeenCalledWith(GOAL_ITEM)
    expect(withoutGoals.hook.result.current.goalMode.active).toBe(false)
  })

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
    // The pane brings the latest into view for a goal it set, as for a sent message.
    expect(onSubmitted).toHaveBeenCalledOnce()
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(readNativeChatDraftCache(SCOPE)).toBe('')
    expect(hook.result.current.goalMode.active).toBe(false)
  })

  it('keeps the draft and goal mode when the goal is refused', async () => {
    const setObjective = vi.fn(async () => false)
    const { hook, calls, onSubmitted, type } = harness({
      draft: '/go',
      threadGoal: { setObjective }
    })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    calls.setDraft.mockClear()
    type('Ship the parser', 0)

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledOnce()
    // Revealed at the press, before the host answered.
    expect(onSubmitted).toHaveBeenCalledOnce()
    expect(calls.setDraft).not.toHaveBeenCalled()
    expect(hook.result.current.goalMode.active).toBe(true)
  })

  it('refuses attachments in goal mode rather than dropping them', () => {
    const setObjective = vi.fn(async () => true)
    const { hook, onError, type } = harness({
      draft: '/go',
      threadGoal: { setObjective },
      imageAttachments: [{ id: 'a1', path: '/tmp/shot.png' }]
    })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    type('Ship the parser', 0)

    act(() => hook.result.current.send())

    expect(setObjective).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith('Remove attachments before setting a goal.')
  })

  it('enters goal mode from a typed bare /goal, like the pick does', () => {
    const { hook, calls } = harness({ draft: '/goal ', threadGoal: { setObjective: vi.fn() } })
    act(() => hook.result.current.send())
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenCalledWith('')
    expect(hook.result.current.goalMode.active).toBe(true)

    // With an objective it is the host command, and without goals it is message text.
    const withObjective = harness({ draft: '/goal ship it', threadGoal: { setObjective: vi.fn() } })
    act(() => withObjective.hook.result.current.send())
    expect(withObjective.calls.sendStructured).toHaveBeenCalledWith('/goal ship it', [])
    const withoutGoals = harness({ draft: '/goal' })
    act(() => withoutGoals.hook.result.current.send())
    expect(withoutGoals.calls.sendStructured).toHaveBeenCalledWith('/goal', [])
    expect(withoutGoals.hook.result.current.goalMode.active).toBe(false)
  })

  it('keeps a bare /goal typed inside goal mode as the entrance, not the objective', () => {
    const setObjective = vi.fn(async () => true)
    const { hook, calls, type } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    calls.setDraft.mockClear()
    type('/goal', 5)

    act(() => hook.result.current.send())

    expect(setObjective).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenCalledWith('')
    expect(hook.result.current.goalMode.active).toBe(true)
  })

  it('sets the objective a /goal typed inside goal mode names, not the literal command', async () => {
    const setObjective = vi.fn(async () => true)
    const { hook, type } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    type('/goal  fix the parser ', 0)

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledWith('fix the parser')
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
    expect(calls.setHistory).toHaveBeenCalledOnce()
    expect(readNativeChatDraftCache(SCOPE)).toBe('Ship the parser and its tests')
    expect(hook.result.current.goalMode.active).toBe(true)
  })

  it('does not send while an image waits to be attached again', () => {
    const { hook, calls } = harness({
      draft: 'see the screenshot',
      imageAttachments: [{ id: 'm1', path: '', unavailableName: 'orca-paste-1-ab.png' }]
    })
    act(() => hook.result.current.send())
    expect(calls.sendStructured).not.toHaveBeenCalled()
  })

  it('sends an ordinary message outside goal mode', () => {
    const { hook, calls } = harness({ draft: 'hello', threadGoal: { setObjective: vi.fn() } })
    act(() => hook.result.current.send())
    expect(calls.sendStructured).toHaveBeenCalledWith('hello', [])
  })

  it('leaves the PTY lane alone: every draft goes to the PTY send, and goal mode never activates', () => {
    const { hook, calls } = harness({ draft: '/goal', lane: 'pty' })
    act(() => hook.result.current.send())
    act(() => hook.result.current.goalMode.interceptPick(calls.setDraft)(GOAL_ITEM))
    expect(calls.sendPty).toHaveBeenCalledOnce()
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenCalledExactlyOnceWith(GOAL_ITEM)
    expect(hook.result.current.goalMode.active).toBe(false)
  })
})
