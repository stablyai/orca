// @vitest-environment happy-dom
// @vitest-environment happy-dom
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

const ATTACHMENT = { id: 'a1', path: '/tmp/shot.png' } as NativeChatComposerImageAttachment

function harness(
  agent: AgentType,
  threadGoal?: NativeChatStructuredComposerTransport['threadGoal'],
  onSubmitted?: () => void
) {
  const structuredTransport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send: vi.fn(() => true),
    dispatchCommand: (text: string) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent,
        sessionCommands: structuredTransport.sessionCommands,
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true,
        conversationCommands: ['clear', 'compact'],
        runConversationCommand: async () => ({ accepted: true, error: null })
      }),
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session-test',
    runtimeEnvironmentId: null
  }
  if (threadGoal) {
    structuredTransport.threadGoal = threadGoal
  }
  structuredTransport.onSubmitted = onSubmitted
  const setDraft = vi.fn()
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent,
      draftScopeKey: 'tab-1:pane',
      imageAttachments: [ATTACHMENT],
      structuredTransport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft,
      setCaret: vi.fn()
    })
  )
  return { send: result.current, structuredTransport, setDraft }
}

it.each([10, 100])(
  'ordinary Send skips %i reported commands for prose and still routes slash controls',
  async (count) => {
    clearNativeChatComposerDraftsForTests()
    let kinds = 0
    let names = 0
    const onSubmitted = vi.fn()
    const { send, structuredTransport } = harness('codex', undefined, onSubmitted)
    structuredTransport.sessionCommands = Array.from({ length: count }, (_, index) => ({
      get kind() {
        kinds++
        return 'command' as const
      },
      get name() {
        names++
        return `provider-${index}`
      }
    }))
    await send('hello', [])
    expect(structuredTransport.send).toHaveBeenCalledExactlyOnceWith('hello', [])
    expect({ kinds, names }).toEqual({ kinds: 0, names: 0 })
    expect(onSubmitted).toHaveBeenCalledOnce()
    await send('/compact', [])
    expect(onSubmitted).toHaveBeenCalledTimes(2)
    expect(structuredTransport.send).toHaveBeenCalledTimes(1)
    expect(structuredTransport.onError).toHaveBeenCalledTimes(2)
    expect(structuredTransport.onError).toHaveBeenNthCalledWith(1, null, undefined)
    expect(structuredTransport.onError).toHaveBeenNthCalledWith(2, null, undefined)
    expect({ kinds, names }).toEqual({ kinds: 0, names: 0 })
  }
)

it.each([
  undefined,
  [],
  [
    { name: 'fast', kind: 'command' as const },
    { name: 'permissions', kind: 'command' as const }
  ]
])(
  'sends provider commands with attachments under inventory %j and retains refused drafts',
  async (inventory) => {
    for (const text of ['/fast', '/permissions']) {
      for (const accepted of [true, false]) {
        clearNativeChatComposerDraftsForTests()
        const { send, structuredTransport, setDraft } = harness('codex')
        structuredTransport.sessionCommands = inventory
        vi.mocked(structuredTransport.send).mockReturnValue(accepted)
        updateNativeChatComposerDraft('tab-1:pane', { text, images: [ATTACHMENT] }, 'immediate')
        await send(text)
        expect(structuredTransport.send).toHaveBeenCalledExactlyOnceWith(text, [ATTACHMENT])
        if (accepted) {
          expect(setDraft).toHaveBeenCalledWith('')
        } else {
          expect(setDraft).not.toHaveBeenCalled()
          expect(readNativeChatComposerDraft('tab-1:pane').text).toBe(text)
        }
      }
    }
  }
)

// Host-owned commands send no message and would drop images; pass-through commands carry their attachments.
describe('attachment guard follows what the host claims', () => {
  it.each([
    ['claude', '/clear'],
    ['claude', '/model']
  ] as const)('refuses attachments on the host-claimed %s command %s', (agent, text) => {
    const { send, structuredTransport } = harness(agent)
    send(text)
    expect(structuredTransport.onError).toHaveBeenCalledWith(
      'Remove attachments before using a chat-session command.'
    )
    expect(structuredTransport.send).not.toHaveBeenCalled()
  })

  it.each([
    ['codex', '/permissions'],
    ['claude', '/fast'],
    ['claude', '/init'],
    ['claude', '/review'],
    ['codex', '/goal ship the fix']
  ] as const)('sends %s attachments along with the passed-through %s', async (agent, text) => {
    const { send, structuredTransport } = harness(agent)
    send(text)
    await vi.waitFor(() =>
      expect(structuredTransport.send).toHaveBeenCalledWith(text, [ATTACHMENT])
    )
    expect(structuredTransport.onError).not.toHaveBeenCalledWith(
      'Remove attachments before using a chat-session command.'
    )
  })

  it('refuses attachments on /goal where the host sets the goal, since no message is sent', () => {
    const setObjective = vi.fn(async () => true)
    const { send, structuredTransport } = harness('codex', { setObjective })
    send('/goal ship the fix')
    expect(structuredTransport.onError).toHaveBeenCalledWith(
      'Remove attachments before using a chat-session command.'
    )
    expect(setObjective).not.toHaveBeenCalled()
    expect(structuredTransport.send).not.toHaveBeenCalled()
  })
})

describe('an attachment still uploading', () => {
  it('holds a picked command, as Send is held, rather than send the chip without its path', async () => {
    const { send, structuredTransport } = harness('claude')
    const pending: NativeChatComposerImageAttachment = {
      id: 'p1',
      path: '',
      pending: true,
      pendingName: 'notes.pdf'
    }
    send('/review', [pending])
    await Promise.resolve()
    expect(structuredTransport.send).not.toHaveBeenCalled()
    expect(structuredTransport.onError).not.toHaveBeenCalled()
  })
})

describe('reports the sends that bring the latest into view', () => {
  it('reports a conversation command at the press, then not a message the transport refused', async () => {
    const onSubmitted = vi.fn()
    const { send, structuredTransport } = harness('claude', undefined, onSubmitted)
    send('/compact', [])
    expect(onSubmitted).toHaveBeenCalledOnce()

    vi.mocked(structuredTransport.send).mockReturnValue(false)
    send('hello', [])
    await vi.waitFor(() => expect(structuredTransport.onError).toHaveBeenCalledTimes(2))
    expect(structuredTransport.send).toHaveBeenCalledWith('hello', [])
    expect(onSubmitted).toHaveBeenCalledOnce()
  })

  it('reports a provider command sent without an inventory', async () => {
    const onSubmitted = vi.fn()
    const { send, structuredTransport } = harness('codex', undefined, onSubmitted)
    await send('/permissions', [])
    expect(structuredTransport.send).toHaveBeenCalledWith('/permissions', [])
    expect(onSubmitted).toHaveBeenCalledOnce()
  })
})

// STA-10671: an older paired host would run the turn without the approval the chat asks for.
describe('a send held by its host', () => {
  it('starts no turn, but still lets an option command through', async () => {
    const { send, structuredTransport } = harness('claude')
    structuredTransport.sendBlockedReason = 'Update Orca on this host to use Ask for approval.'
    await send('hello', [])
    await send('/compact', [])
    expect(structuredTransport.send).not.toHaveBeenCalled()
    expect(structuredTransport.onError).not.toHaveBeenCalled()

    await send('/model', [])
    expect(structuredTransport.onError).toHaveBeenCalled()
  })
})

describe("says a failed send in Orca's words, with the error it hit apart", () => {
  it('keeps a main-process failure apart from the words saying the message was not sent', async () => {
    const { send, structuredTransport } = harness('claude')
    vi.mocked(structuredTransport.send).mockImplementation(() => {
      throw new Error(
        "Error invoking remote method 'agentSession:send': Error: connect ECONNREFUSED /tmp/a.sock"
      )
    })
    send('hello', [])
    await vi.waitFor(() =>
      expect(structuredTransport.onError).toHaveBeenCalledWith('Your message was not sent.', {
        errorText: 'connect ECONNREFUSED /tmp/a.sock'
      })
    )
    updateNativeChatComposerDraft('tab-1:pane', { text: '$review' }, 'immediate')
    const before = readNativeChatComposerDraft('tab-1:pane')
    vi.mocked(structuredTransport.send).mockImplementation((text) =>
      Boolean(
        structuredAgentSessionSendBody(
          text,
          [],
          Array.from({ length: 17 }, (_, path) => ({ name: 'review', path: `/${path}` }))
        )
      )
    )
    await send('$review', [])
    expect(readNativeChatComposerDraft('tab-1:pane')).toBe(before)
    expect(structuredTransport.onError).toHaveBeenLastCalledWith(
      'Your message was not sent to Claude. Keep at most 16 selected skill files and try again.',
      { errorText: undefined }
    )
  })
})

it('settles captured command text without publishing obsolete notices', async () => {
  const { send, structuredTransport } = harness('codex', { setObjective: async () => true })
  const reply =
    Promise.withResolvers<Awaited<ReturnType<typeof structuredTransport.dispatchCommand>>>()
  let current = true
  structuredTransport.capturePresentation = () => () => current
  structuredTransport.dispatchCommand = () => reply.promise
  updateNativeChatComposerDraft('tab-1:pane', { text: '/goal ship it' }, 'immediate')
  const pending = send('/goal ship it', [])
  current = false
  updateNativeChatComposerDraft('tab-1:pane', { text: '/goal ship it next' }, 'immediate')
  reply.resolve({ handled: true, accepted: true, error: null })
  await pending
  expect(readNativeChatComposerDraft('tab-1:pane').text).toBe(' next')
  expect(structuredTransport.onError).not.toHaveBeenCalled()
})

it('checks both the picked command and its draft, and projects completed paths', async () => {
  const { send, structuredTransport } = harness('claude')
  const id = '00000000-0000-4000-8000-000000000000'
  const token = `[Pasted text](orca-paste:${id})`
  await send(token, [])
  updateNativeChatComposerDraft('tab-1:pane', { text: token }, 'immediate')
  await send('/review', [])
  expect(structuredTransport.send).not.toHaveBeenCalled()
  updateNativeChatComposerDraft(
    'tab-1:pane',
    { pastedTextFiles: { [id]: '/p/saved.txt' } },
    'immediate'
  )
  await send(`a${token}${token}b`, [])
  expect(structuredTransport.send).toHaveBeenCalledWith('a @/p/saved.txt @/p/saved.txt b', [])
  clearNativeChatComposerDraftsForTests()
})

it.each(['claude', 'codex'] as const)(
  'keeps an oversized %s draft before transport admission',
  async (agent) => {
    clearNativeChatComposerDraftsForTests()
    const { send, structuredTransport, setDraft } = harness(agent)
    const text = 'x'.repeat(270014)
    updateNativeChatComposerDraft('tab-1:pane', { text }, 'immediate')
    const submitted = readNativeChatComposerDraft('tab-1:pane')
    await send(text, [])
    expect(structuredTransport.send).not.toHaveBeenCalled()
    expect(structuredTransport.onError).toHaveBeenCalledWith(
      expect.stringContaining('over the 256 KB limit'),
      undefined
    )
    expect(setDraft).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft('tab-1:pane')).toBe(submitted)
    clearNativeChatComposerDraftsForTests()
  }
)

import * as draftStore from './native-chat-composer-draft-store'
import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  discardNativeChatQueuedEdit
} from './native-chat-queued-edit-draft'
import {
  createMemoryNativeChatComposerDraftStorage,
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  setNativeChatComposerDraftStorageForTests
} from './native-chat-composer-draft-storage'
import { useNativeChatDraft } from './use-native-chat-draft'
import { NativeChatPromptEditor } from './NativeChatPromptEditor'
import { promptEditor } from './native-chat-prompt-editor.test-support'
import { promptSkillRefs } from './native-chat-prompt-document'

describe('complete handback acceptance', () => {
  const scope = 'agent-session:rich-return'
  const composing = false
  beforeEach(async () => {
    localStorage.clear()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
    await hydrateNativeChatComposerDrafts()
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    clearNativeChatComposerDraftsForTests()
  })
  function returned() {
    const edit = createNativeChatQueuedEditDraft(
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '$review' }],
        skills: [{ name: 'review', path: '/returned/SKILL.md' }]
      },
      scope
    )
    const value = readNativeChatComposerDraft(edit.scopeKey)
    updateNativeChatComposerDraft(
      edit.scopeKey,
      {
        text: '$review changed',
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [
                ...(value.document?.content?.[0].content ?? []),
                { type: 'text', text: ' changed' }
              ]
            }
          ]
        }
      },
      'immediate'
    )
    return edit
  }

  function acceptanceFixture() {
    const goal = Promise.withResolvers<boolean>()
    let current = true
    const caret = vi.fn()
    const clearOrigin = vi.fn()
    const transport: NativeChatStructuredComposerTransport = {
      capturePresentation: () => () => current,
      send: vi.fn(() => true),
      threadGoal: { setObjective: () => goal.promise },
      dispatchCommand: (text) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          agent: 'codex',
          snapshot: [],
          invokeAction: async () => true,
          setOption: async () => true,
          setThreadGoalObjective: () => goal.promise
        }),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: vi.fn(),
        invokeAction: vi.fn(),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: vi.fn(),
      runtime: 'local',
      sessionId: 'rich-return',
      runtimeEnvironmentId: null
    }
    function useSend(key: string) {
      const draft = useNativeChatDraft(key, () => composing)
      const send = useNativeChatStructuredComposerSend({
        agent: 'codex',
        draftScopeKey: key,
        imageAttachments: [],
        structuredTransport: transport,
        isComposing: () => composing,
        clearSkillOrigin: clearOrigin,
        setDraft: draft.setDraft,
        setCaret: caret
      })
      return { ...draft, send }
    }
    const mount = () => renderHook(({ key }) => useSend(key), { initialProps: { key: scope } })
    return {
      goal,
      transport,
      caret,
      clearOrigin,
      useSend,
      mount,
      depart: () => {
        current = false
      },
      arrive: () => {
        current = true
      }
    }
  }

  it.each(['current', 'obsolete'] as const)(
    'retains accepted handback node identity through %s presentation and the next actual Send',
    async (presentation) => {
      const fixture = acceptanceFixture()
      updateNativeChatComposerDraft(scope, { text: '/goal ship it' }, 'immediate')
      const hook = fixture.mount()
      let pending: Promise<void> | undefined
      act(() => {
        pending = hook.result.current.send('/goal ship it', [])
      })
      const edit = returned()
      act(() => {
        handBackNativeChatQueuedEdit(edit)
        discardNativeChatQueuedEdit(edit)
      })
      expect(promptSkillRefs(readNativeChatComposerDraft(scope).document)).toEqual([
        { name: 'review', path: '/returned/SKILL.md' }
      ])
      const other = 'agent-session:other-host'
      if (presentation === 'obsolete') {
        fixture.depart()
        updateNativeChatComposerDraft(other, { text: 'other untouched' }, 'immediate')
        hook.rerender({ key: other })
        hook.unmount()
      }
      await act(async () => {
        fixture.goal.resolve(true)
        await pending
      })
      const left = readNativeChatComposerDraft(scope)
      expect(left.text).toBe('\n\n$review changed')
      expect(promptSkillRefs(left.document)).toEqual([
        { name: 'review', path: '/returned/SKILL.md' }
      ])
      if (presentation === 'obsolete') {
        expect(readNativeChatComposerDraft(other).text).toBe('other untouched')
        expect(fixture.caret).not.toHaveBeenCalled()
        expect(fixture.clearOrigin).not.toHaveBeenCalled()
        expect(fixture.transport.onError).not.toHaveBeenCalled()
      }
      hook.unmount()
      fixture.arrive()
      const next = fixture.mount()
      await act(async () => next.result.current.send(next.result.current.draft, []))
      expect(fixture.transport.send).toHaveBeenCalledExactlyOnceWith(left.text, [], {
        skills: [{ name: 'review', path: '/returned/SKILL.md' }]
      })
    }
  )

  it('subtracts only submitted nodes when an ordinary message yields to a handback before admission, and persists the latest remainder', async () => {
    const fixture = acceptanceFixture()
    const seed = createNativeChatQueuedEditDraft(
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '$review sent' }],
        skills: [{ name: 'review', path: '/sent/SKILL.md' }]
      },
      scope
    )
    updateNativeChatComposerDraft(scope, readNativeChatComposerDraft(seed.scopeKey), 'immediate')
    discardNativeChatQueuedEdit(seed)
    const hook = fixture.mount()
    let pending: Promise<void> | undefined
    act(() => {
      pending = hook.result.current.send('$review sent', [])
    })
    const edit = returned()
    act(() => {
      handBackNativeChatQueuedEdit(edit)
      discardNativeChatQueuedEdit(edit)
    })
    // Latest actual document wins, not a union with either captured snapshot.
    const view = render(
      <NativeChatPromptEditor
        scopeKey={scope}
        inputRef={createRef()}
        initialValue={readNativeChatComposerDraft(scope).text}
        disabled={false}
        placeholder="Returned draft"
        onChange={(input) => hook.result.current.setDraft(input.value)}
        onSelect={() => {}}
      />
    )
    const editor = promptEditor(screen.getByRole('textbox'))
    // Edit the surviving selected node through the actual editor transaction.
    let selected = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'nativeChatSkill' && node.attrs.path === '/returned/SKILL.md') {
        selected = pos
      }
    })
    expect(selected).toBeGreaterThanOrEqual(0)
    act(() =>
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(selected, undefined, {
          token: '$review',
          path: '/latest/SKILL.md'
        })
      )
    )
    await act(async () => pending)
    const left = readNativeChatComposerDraft(scope)
    expect(left.text).toBe('\n\n$review changed')
    expect(promptSkillRefs(left.document)).toEqual([{ name: 'review', path: '/latest/SKILL.md' }])
    expect(fixture.transport.send).toHaveBeenNthCalledWith(1, '$review sent', [], {
      skills: [{ name: 'review', path: '/sent/SKILL.md' }]
    })
    await nativeChatComposerDraftWritesSettled()
    const stored = parseStoredNativeChatComposerDraft(
      await nativeChatComposerDraftStorage().read(scope)
    )
    expect(stored?.text).toBe(left.text)
    expect(promptSkillRefs(stored?.document)).toEqual([
      { name: 'review', path: '/latest/SKILL.md' }
    ])
    view.unmount()
    hook.unmount()
    const next = fixture.mount()
    await act(async () => next.result.current.send(next.result.current.draft, []))
    expect(fixture.transport.send).toHaveBeenNthCalledWith(2, left.text, [], {
      skills: [{ name: 'review', path: '/latest/SKILL.md' }]
    })
  })

  it('keeps main obsolete-command cleanup when no complete handback participates', async () => {
    const fixture = acceptanceFixture()
    updateNativeChatComposerDraft(scope, { text: '/goal ship it' }, 'immediate')
    const hook = fixture.mount()
    let pending: Promise<void> | undefined
    act(() => {
      pending = hook.result.current.send('/goal ship it', [])
    })
    const ordinary = returned()
    const value = readNativeChatComposerDraft(ordinary.scopeKey)
    act(() =>
      updateNativeChatComposerDraft(
        scope,
        {
          text: `/goal ship it\n\n${value.text}`,
          document: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: '/goal ship it' }] },
              { type: 'paragraph' },
              ...(value.document?.content ?? [])
            ]
          }
        },
        'immediate'
      )
    )
    discardNativeChatQueuedEdit(ordinary)
    fixture.depart()
    hook.unmount()
    await act(async () => {
      fixture.goal.resolve(true)
      await pending
    })
    expect(readNativeChatComposerDraft(scope).text).toBe('\n\n$review changed')
    expect(readNativeChatComposerDraft(scope).document).toBeUndefined()
    expect(fixture.caret).not.toHaveBeenCalled()
  })

  it.each([10, 100])(
    'bounds in-flight handback observation beside %i unrelated mounted drafts and disposes on every settlement',
    async (count) => {
      const original = draftStore.subscribeToNativeChatComposerDraftAppend
      const active = new Map<string, number>()
      const calls = new Map<string, number>()
      vi.spyOn(draftStore, 'subscribeToNativeChatComposerDraftAppend').mockImplementation(
        (key, callback) => {
          active.set(key, (active.get(key) ?? 0) + 1)
          const release = original(key, (addition, previous) => {
            calls.set(key, (calls.get(key) ?? 0) + 1)
            callback(addition, previous)
          })
          return () => {
            active.set(key, active.get(key)! - 1)
            release()
          }
        }
      )
      const renders = Array.from({ length: count }, () => 0)
      const idle = renders.map((_, index) =>
        renderHook(() => {
          renders[index]++
          return useNativeChatDraft(`agent-session:other-host-${index}`, () => false)
        })
      )
      await act(async () => {})
      renders.fill(0)
      for (const settlement of ['accepted', 'refused', 'error', 'replacement'] as const) {
        const fixture = acceptanceFixture()
        act(() =>
          updateNativeChatComposerDraft(
            scope,
            { text: '/goal ship it', document: undefined, images: [] },
            'immediate'
          )
        )
        const hook = fixture.mount()
        expect(active.get(scope)).toBe(1)
        let pending: Promise<void> | undefined
        act(() => {
          pending = hook.result.current.send('/goal ship it', [])
        })
        expect(active.get(scope)).toBe(2)
        calls.clear()
        const edit = returned()
        act(() => {
          handBackNativeChatQueuedEdit(edit)
          handBackNativeChatQueuedEdit(edit)
          discardNativeChatQueuedEdit(edit)
        })
        expect(calls.get(scope)).toBe(2)
        expect([...calls.keys()]).toEqual([scope])
        if (settlement === 'replacement') {
          act(() =>
            updateNativeChatComposerDraft(
              scope,
              {
                text: 'replacement',
                document: {
                  type: 'doc',
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'replacement' }] }]
                }
              },
              'immediate'
            )
          )
        }
        const before = readNativeChatComposerDraft(scope)
        await act(async () => {
          if (settlement === 'error') {
            fixture.goal.reject(new Error('host request failed'))
          } else {
            fixture.goal.resolve(settlement !== 'refused')
          }
          await pending
        })
        expect(active.get(scope)).toBe(1)
        if (settlement !== 'accepted') {
          expect(readNativeChatComposerDraft(scope)).toEqual(before)
        }
        expect(renders).toEqual(Array(count).fill(0))
        // A later ordinary invocation has no inherited participation, even in the same mounted hook.
        act(() =>
          updateNativeChatComposerDraft(
            scope,
            { text: 'ordinary later', document: undefined, images: [] },
            'immediate'
          )
        )
        await act(async () => hook.result.current.send('ordinary later', []))
        expect(readNativeChatComposerDraft(scope).text).toBe('')
        expect(active.get(scope)).toBe(1)
        hook.unmount()
        expect(active.get(scope)).toBe(0)
        calls.clear()
        const later = returned()
        act(() => {
          handBackNativeChatQueuedEdit(later)
          discardNativeChatQueuedEdit(later)
        })
        expect(calls.size).toBe(0)
      }
      idle.forEach((view) => view.unmount())
      expect([...active.values()].every((value) => value === 0)).toBe(true)
    }
  )
})
