// @vitest-environment happy-dom
import { currentDraftScope } from './native-chat-launch-draft-source'
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatPickerItem } from '../../../../shared/native-chat/input/native-chat-picker-items'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { useNativeChatComposerSubmit } from './use-native-chat-composer-submit'
import { updateNativeChatComposerDraft } from './native-chat-composer-draft-store'
import { nativeChatPastedTextOperations } from './native-chat-pasted-text-reference'
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
  lane?: 'pty'
  submitEmpty?: () => void
  capturePresentation?: NativeChatStructuredComposerTransport['capturePresentation']
}) {
  const onError = vi.fn()
  const onSubmitted = vi.fn()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: submit reads only threadGoal, onError and onSubmitted.
  const structuredTransport = {
    capturePresentation: options.capturePresentation ?? (() => () => true),
    onError,
    onSubmitted,
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
    (props: { draft: string; caret: number }) =>
      useNativeChatComposerSubmit({
        structuredTransport: options.lane === 'pty' ? undefined : structuredTransport,
        draftScopeKey: SCOPE,
        draft: props.draft,
        caret: props.caret,
        imageAttachments: options.imageAttachments ?? [],
        disabled: false,
        submitEmpty: options.submitEmpty,
        ...calls
      }),
    { initialProps: { draft: options.draft, caret: options.caret ?? options.draft.length } }
  )
  const type = (draft: string, caret: number): void => {
    writeNativeChatDraftCache(SCOPE, draft)
    hook.rerender({ draft, caret })
  }
  return { hook, calls, onError, onSubmitted, type }
}

describe('composer goal mode', () => {
  it.each([false, true])(
    'admits the actual ordinary/goal candidate only after completion, goal=%s',
    async (goal) => {
      const setObjective = vi.fn(async () => true)
      const { hook, calls, onError, type } = harness({
        draft: '/go',
        threadGoal: { setObjective }
      })
      if (goal) {
        act(() => hook.result.current.goalMode.interceptPick(vi.fn())(GOAL_ITEM))
      }
      const token = '[Pasted text](orca-paste:00000000-0000-4000-8000-000000000000)'
      type(token, 0)
      const id = '00000000-0000-4000-8000-000000000000'
      nativeChatPastedTextOperations.set(id, { scopeKey: SCOPE, text: 'original' })
      act(() => hook.result.current.send())
      expect(onError).not.toHaveBeenCalled()
      nativeChatPastedTextOperations.clear()
      act(() => hook.result.current.send())
      expect(onError).toHaveBeenCalledWith('This paste was not saved. Paste it again or remove it.')
      expect(calls.sendStructured).not.toHaveBeenCalled()
      expect(readNativeChatDraftCache(SCOPE)).toBe(token)
      updateNativeChatComposerDraft(
        SCOPE,
        { pastedTextFiles: { [id]: '/p/saved.txt' } },
        'immediate'
      )
      await act(async () => hook.result.current.send())
      if (goal) {
        expect(setObjective).toHaveBeenCalledWith('@/p/saved.txt')
      } else {
        expect(calls.sendStructured).toHaveBeenCalledWith(token, [])
      }
    }
  )

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

it('admits optional empty launch only after the shared pending-attachment boundary', () => {
  const submitEmpty = vi.fn()
  const ordinary = harness({ draft: '' })
  act(() => ordinary.hook.result.current.send())
  expect(ordinary.calls.sendStructured).not.toHaveBeenCalled()
  ordinary.hook.unmount()
  const held = harness({
    draft: '',
    submitEmpty,
    imageAttachments: [{ id: 'pending', path: '', pending: true }]
  })
  act(() => held.hook.result.current.send())
  expect(submitEmpty).not.toHaveBeenCalled()
  held.hook.unmount()
  const launch = harness({ draft: '   ', submitEmpty })
  act(() => launch.hook.result.current.send())
  expect(submitEmpty).toHaveBeenCalledOnce()
  expect(launch.calls.sendStructured).not.toHaveBeenCalled()
})

import * as draftStore from './native-chat-composer-draft-store'
import {
  readNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests
} from './native-chat-composer-draft-store'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'
import { useNativeChatDraft } from './use-native-chat-draft'
import { promptSkillRefs } from './native-chat-prompt-document'

it('recovers two distinct rich submissions across remount/new input without late success clearing either recovery', async () => {
  clearNativeChatComposerDraftsForTests()
  let scope = draftStore.nativeChatLaunchPromptDraftScopeKey('workspace', 'codex', 'ssh:host')
  const replies = Array.from({ length: 3 }, () => Promise.withResolvers<boolean>())
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: scope,
    runtimeEnvironmentId: null,
    send: vi
      .fn()
      .mockImplementationOnce(() => replies[0].promise)
      .mockImplementationOnce(() => replies[1].promise)
      .mockImplementationOnce(() => replies[2].promise)
      .mockReturnValue(true)
  }
  const rich = (path: string) => ({
    text: '$review',
    images: [{ id: path, path: `${path}.png` }],
    pastedTextFiles: {},
    document: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'nativeChatSkill', attrs: { token: '$review', path } }]
        }
      ]
    }
  })
  const mount = () =>
    renderHook(() => {
      const draft = useNativeChatDraft(scope, () => false)
      return useNativeChatStructuredComposerSend({
        agent: 'codex',
        draftScopeKey: scope,
        imageAttachments: [],
        structuredTransport: transport,
        isComposing: () => false,
        clearSkillOrigin: () => {},
        setDraft: draft.setDraft,
        setCaret: () => {}
      })
    })
  let hook = mount()
  const pending: Promise<void>[] = []
  for (const path of ['/one/SKILL.md', '/two/SKILL.md', '/success/SKILL.md']) {
    act(() => updateNativeChatComposerDraft(scope, rich(path), 'immediate'))
    await act(async () => {
      pending.push(hook.result.current('$review', readNativeChatComposerDraft(scope).images))
    })
    expect(readNativeChatComposerDraft(scope).text).toBe('')
  }
  hook.unmount()
  const otherHost = draftStore.nativeChatLaunchPromptDraftScopeKey('workspace', 'codex', 'local')
  updateNativeChatComposerDraft(otherHost, { text: 'other host' }, 'immediate')
  const pasteId = '00000000-0000-4000-8000-000000000000'
  const newer = `new [Pasted text](orca-paste:${pasteId}) @/new/file`
  updateNativeChatComposerDraft(
    scope,
    {
      text: newer,
      document: undefined,
      images: [],
      pastedTextFiles: { [pasteId]: '/saved/paste.txt' }
    },
    'immediate'
  )
  await act(async () => {
    replies[0].resolve(false)
    await pending[0]
  })
  await act(async () => {
    replies[1].reject(new Error('connection lost'))
    await pending[1]
  })
  const recovered = readNativeChatComposerDraft(scope)
  expect(promptSkillRefs(recovered.document)).toEqual([
    { name: 'review', path: '/one/SKILL.md' },
    { name: 'review', path: '/two/SKILL.md' }
  ])
  expect(recovered.text).toContain(newer)
  expect(recovered.pastedTextFiles).toEqual({ [pasteId]: '/saved/paste.txt' })
  expect(recovered.images.map(({ path }) => path)).toEqual([
    '/one/SKILL.md.png',
    '/two/SKILL.md.png'
  ])
  await act(async () => {
    replies[2].resolve(true)
    await pending[2]
  })
  expect(readNativeChatComposerDraft(scope)).toBe(recovered)
  expect(readNativeChatComposerDraft(otherHost).text).toBe('other host')
  hook = mount()
  await act(async () => hook.result.current(recovered.text, recovered.images))
  expect(transport.send).toHaveBeenCalledTimes(4)
  expect(readNativeChatComposerDraft(scope).text).toBe('')
  hook.unmount()
  for (const accepted of [false, true]) {
    const reply = Promise.withResolvers<boolean>()
    vi.mocked(transport.send).mockReturnValueOnce(reply.promise)
    hook = mount()
    act(() => updateNativeChatComposerDraft(scope, rich('/retired/SKILL.md'), 'immediate'))
    let old: Promise<void> | undefined
    await act(async () => {
      old = hook.result.current('$review', [])
    })
    hook.unmount()
    draftStore.deleteNativeChatComposerDraftsOwnedBy({
      workspaceId: 'workspace',
      executionHostId: 'ssh:host'
    })
    const successorScope = draftStore.nativeChatLaunchPromptDraftScopeKey(
      'workspace',
      'codex',
      'ssh:host'
    )
    updateNativeChatComposerDraft(successorScope, rich('/recreated/SKILL.md'), 'immediate')
    const recreated = readNativeChatComposerDraft(successorScope)
    await act(async () => {
      reply.resolve(accepted)
      await old
    })
    expect(readNativeChatComposerDraft(successorScope)).toBe(recreated)
    scope = successorScope
  }
  clearNativeChatComposerDraftsForTests()
})

import { createTestStore, TEST_REPO } from '@/store/slices/store-test-helpers'
import { captureLaunchDraftDestination } from './native-chat-launch-draft-source'
import {
  useNativeChatPastedTextFile,
  NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD
} from './use-native-chat-pasted-text-file'

it.each([
  [false, false],
  [true, false],
  [false, true],
  [true, true]
])(
  'two actual send iterations retain rich source through collision, move, remount, reverse=%s firstAccepted=%s',
  async (reverse, firstAccepted) => {
    clearNativeChatComposerDraftsForTests()
    const store = createTestStore()
    const workspace = 'repo::/work'
    const from = draftStore.nativeChatLaunchPromptDraftScopeKey(workspace, 'codex', 'ssh:old')
    const target = draftStore.nativeChatLaunchPromptDraftScopeKey(workspace, 'codex', 'ssh:new')
    const replies = [Promise.withResolvers<boolean>(), Promise.withResolvers<boolean>()]
    const send = vi
      .fn()
      .mockReturnValueOnce(replies[0].promise)
      .mockReturnValueOnce(replies[1].promise)
      .mockReturnValue(true)
    const transport: NativeChatStructuredComposerTransport = {
      capturePresentation: () => () => true,
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: vi.fn(),
        invokeAction: vi.fn(),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: vi.fn(),
      runtime: 'local',
      sessionId: from,
      runtimeEnvironmentId: null,
      send
    }
    const rich = (path: string) => ({
      text: '$review',
      images: [
        { id: 'shared', path: '/shared.png' },
        { id: path, path: `${path}.png` }
      ],
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'nativeChatSkill', attrs: { token: '$review', path } }]
          }
        ]
      }
    })
    const mount = (scope: string) =>
      renderHook(() => {
        const draft = useNativeChatDraft(scope, () => false)
        const submit = useNativeChatStructuredComposerSend({
          agent: 'codex',
          draftScopeKey: scope,
          imageAttachments: [],
          structuredTransport: transport,
          isComposing: () => false,
          clearSkillOrigin: () => {},
          setDraft: draft.setDraft,
          setCaret: () => {}
        })
        return { ...draft, submit }
      })
    let old = mount(from)
    let next = mount(target)
    act(() => {
      updateNativeChatComposerDraft(from, rich('/one/SKILL.md'), 'immediate')
      updateNativeChatComposerDraft(target, rich('/two/SKILL.md'), 'immediate')
    })
    const operations: Promise<void>[] = []
    await act(async () => {
      operations.push(
        old.result.current.submit('$review', readNativeChatComposerDraft(from).images)
      )
      operations.push(
        next.result.current.submit('$review', readNativeChatComposerDraft(target).images)
      )
    })
    expect(readNativeChatComposerDraft(from).text).toBe('')
    expect(readNativeChatComposerDraft(target).text).toBe('')
    const staleSetter = old.result.current.setDraft
    const handle = captureLaunchDraftDestination(from)
    act(() => {
      staleSetter('new source input')
      next.result.current.setDraft('new target input')
      store.setState({
        repos: [{ ...TEST_REPO, id: 'repo', connectionId: 'new', executionHostId: 'ssh:new' }]
      })
      const events = [{ oldTargetId: 'old', newTargetId: 'new', repoIds: ['repo'] }]
      store.getState().recordSshRepoReadoptions(events)
    })
    expect(handle).toMatchObject({ scopeKey: currentDraftScope(target), active: true })
    old.unmount()
    next.unmount()
    old = mount(from)
    next = mount(target)
    await act(async () => {
      const first = reverse ? 1 : 0
      replies[first].resolve(firstAccepted)
      await operations[first]
      replies[1 - first].reject(new Error('no recipient'))
      await operations[1 - first]
    })
    const recovered = readNativeChatComposerDraft(target)
    expect(recovered.text).toContain('new source input')
    expect(recovered.text).toContain('new target input')
    const paths = (
      reverse ? ['/two/SKILL.md', '/one/SKILL.md'] : ['/one/SKILL.md', '/two/SKILL.md']
    ).slice(firstAccepted ? 1 : 0)
    expect(promptSkillRefs(recovered.document)).toEqual(
      paths.map((path) => ({ name: 'review', path }))
    )
    expect(new Set(recovered.images.map(({ id }) => id))).toEqual(new Set(['shared', ...paths]))
    act(() => {
      store.setState({
        repos: [{ ...TEST_REPO, id: 'repo', connectionId: 'third', executionHostId: 'ssh:third' }]
      })
      const events = [{ oldTargetId: 'new', newTargetId: 'third', repoIds: ['repo'] }]
      store.getState().recordSshRepoReadoptions(events)
    })
    expect(
      readNativeChatComposerDraft(
        draftStore.nativeChatLaunchPromptDraftScopeKey(workspace, 'codex', 'ssh:third')
      )
    ).toBe(readNativeChatComposerDraft(target))
    await act(async () => next.result.current.submit(recovered.text, recovered.images))
    expect(send).toHaveBeenCalledTimes(3)
    expect(readNativeChatComposerDraft(from).text).toBe('')
    old.unmount()
    next.unmount()
    // Real long-paste preparation starts before capture and follows the continuing source after closure.
    const saved = Promise.withResolvers<string>()
    vi.stubGlobal('window', { api: { ui: { savePastedTextAsFile: vi.fn(() => saved.promise) } } })
    let staged = ''
    const preparation = renderHook(() =>
      useNativeChatPastedTextFile({
        scopeKey: from,
        scopeEditor: () => ({
          value: '',
          selectionStart: 0,
          selectionEnd: 0,
          disabled: false,
          focus: () => {},
          select: () => {},
          setSelectionRange: () => {},
          stagePastedText: (token: string) => {
            staged = token
            updateNativeChatComposerDraft(from, { text: token }, 'immediate')
          }
        }),
        resolveAttachmentOwner: () => ({ kind: 'local' }),
        insertTypedText: () => false,
        setNotice: vi.fn()
      })
    )
    act(() =>
      expect(preparation.result.current('x'.repeat(NATIVE_CHAT_PASTED_TEXT_FILE_THRESHOLD))).toBe(
        true
      )
    )
    preparation.unmount()
    act(() => {
      store.setState({
        repos: [{ ...TEST_REPO, id: 'repo', connectionId: 'fourth', executionHostId: 'ssh:fourth' }]
      })
      const events = [{ oldTargetId: 'third', newTargetId: 'fourth', repoIds: ['repo'] }]
      store.getState().recordSshRepoReadoptions(events)
    })
    if (!reverse) {
      await act(async () => {
        saved.resolve('/saved-paste.txt')
        await saved.promise
      })
      expect(Object.values(readNativeChatComposerDraft(target).pastedTextFiles ?? {})).toEqual([
        '/saved-paste.txt'
      ])
    }
    // Ordinary exact deletion cancels a new automatic return writer; it does not retire setup identity.
    act(() => draftStore.deleteNativeChatComposerDraft(target))
    const fresh = draftStore.nativeChatLaunchPromptDraftScopeKey(workspace, 'codex', 'ssh:fourth')
    updateNativeChatComposerDraft(fresh, rich('/fresh/SKILL.md'), 'immediate')
    const successor = readNativeChatComposerDraft(fresh)
    await act(async () => {
      saved.resolve('/late-paste.txt')
      await saved.promise
    })
    expect(readNativeChatComposerDraft(fresh)).toBe(successor)
    expect(staged).toContain('orca-paste:')
    expect(handle?.active).toBe(true)
    vi.unstubAllGlobals()
    clearNativeChatComposerDraftsForTests()
  }
)
