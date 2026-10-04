// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatPickerItem } from './native-chat-picker-items'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'

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
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: submit reads only threadGoal and onError.
  const structuredTransport = {
    onError,
    ...(options.threadGoal ? { threadGoal: options.threadGoal } : {})
  } as unknown as NativeChatStructuredComposerTransport
  const calls = {
    sendPty: vi.fn(),
    sendStructured: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    setHistory: vi.fn()
  }
  const hook = renderHook(
    (props: { draft: string; caret: number }) =>
      useNativeChatComposerSubmit({
        structuredTransport: options.lane === 'pty' ? undefined : structuredTransport,
        draft: props.draft,
        caret: props.caret,
        imageAttachments: options.imageAttachments ?? [],
        disabled: false,
        ...calls
      }),
    { initialProps: { draft: options.draft, caret: options.caret ?? options.draft.length } }
  )
  return { hook, calls, onError }
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
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    hook.rerender({ draft: '  Ship the parser  ', caret: 0 })

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledWith('Ship the parser')
    expect(calls.sendStructured).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenLastCalledWith('')
    expect(hook.result.current.goalMode.active).toBe(false)
  })

  it('keeps the draft and goal mode when the goal is refused', async () => {
    const setObjective = vi.fn(async () => false)
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    calls.setDraft.mockClear()
    hook.rerender({ draft: 'Ship the parser', caret: 0 })

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledOnce()
    expect(calls.setDraft).not.toHaveBeenCalled()
    expect(hook.result.current.goalMode.active).toBe(true)
  })

  it('refuses attachments in goal mode rather than dropping them', () => {
    const setObjective = vi.fn(async () => true)
    const { hook, onError } = harness({
      draft: '/go',
      threadGoal: { setObjective },
      imageAttachments: [{ id: 'a1', path: '/tmp/shot.png' }]
    })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    hook.rerender({ draft: 'Ship the parser', caret: 0 })

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
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    calls.setDraft.mockClear()
    hook.rerender({ draft: '/goal', caret: 5 })

    act(() => hook.result.current.send())

    expect(setObjective).not.toHaveBeenCalled()
    expect(calls.setDraft).toHaveBeenCalledWith('')
    expect(hook.result.current.goalMode.active).toBe(true)
  })

  it('sets the objective a /goal typed inside goal mode names, not the literal command', async () => {
    const setObjective = vi.fn(async () => true)
    const { hook } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    hook.rerender({ draft: '/goal  fix the parser ', caret: 0 })

    await act(async () => hook.result.current.send())

    expect(setObjective).toHaveBeenCalledWith('fix the parser')
    expect(hook.result.current.goalMode.active).toBe(false)
  })

  it('keeps a draft edited while the goal was in flight, and stays in goal mode', async () => {
    let settle: (accepted: boolean) => void = () => undefined
    const setObjective = vi.fn(() => new Promise<boolean>((resolve) => (settle = resolve)))
    const { hook, calls } = harness({ draft: '/go', threadGoal: { setObjective } })
    act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
    hook.rerender({ draft: 'Ship the parser', caret: 0 })
    calls.setDraft.mockClear()

    act(() => hook.result.current.send())
    hook.rerender({ draft: 'Ship the parser and its tests', caret: 0 })
    await act(async () => settle(true))

    expect(setObjective).toHaveBeenCalledWith('Ship the parser')
    expect(calls.setHistory).toHaveBeenCalledOnce()
    expect(calls.setDraft).not.toHaveBeenCalled()
    expect(hook.result.current.goalMode.active).toBe(true)
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
