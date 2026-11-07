// @vitest-environment happy-dom
// @vitest-environment happy-dom

// @vitest-environment happy-dom
// @vitest-environment happy-dom
import { clearNativeChatComposerDraftsForTests } from '../../drafts/native-chat-draft-reset'
// @vitest-environment happy-dom
// @vitest-environment happy-dom
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../drafts/native-chat-composer-draft-store'
import { hydrateNativeChatComposerDrafts } from '../../drafts/native-chat-composer-draft-load'
import { nativeChatComposerDraftWritesSettled } from '../../drafts/native-chat-composer-draft-persistence'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'

import type { NativeChatStructuredComposerTransport } from './native-chat-structured-composer-transport'

import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatMessageSent: vi.fn()
}))

import {
  createNativeChatQueuedEditDraft,
  handBackNativeChatQueuedEdit,
  discardNativeChatQueuedEdit
} from '../../queue/editing/native-chat-queued-edit-draft'
import {
  createMemoryNativeChatComposerDraftStorage,
  nativeChatComposerDraftStorage,
  parseStoredNativeChatComposerDraft,
  setNativeChatComposerDraftStorageForTests
} from '../../drafts/native-chat-composer-draft-storage'
import { useNativeChatDraft } from '../../drafts/use-native-chat-draft'
import { NativeChatPromptEditor } from '../editor/NativeChatPromptEditor'
import { promptEditor } from '../editor/native-chat-prompt-editor.test-support'
import { promptSkillRefs } from '../editor/native-chat-prompt-document'
import { structuredConversationCommandRunner } from '../../session/structured/writes/structured-conversation-command-send'
import type { AgentSessionConversationCommandResult } from '../../../../../../shared/agent-session/agent-session-conversation-command'
import type { StructuredAgentSessionWriteOutcome } from '../../session/structured/writes/use-structured-agent-session-mutate'

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
          changeThreadGoal: () => goal.promise
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
    let pending: Promise<boolean> | undefined
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
})

describe('a conversation command leaves the composer once it is sent', () => {
  const scope = 'agent-session:compact-draft'
  beforeEach(async () => {
    localStorage.clear()
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(createMemoryNativeChatComposerDraftStorage())
    await hydrateNativeChatComposerDrafts()
  })
  afterEach(() => {
    cleanup()
    clearNativeChatComposerDraftsForTests()
  })

  async function sendCompactWhileHostAnswers() {
    const host =
      Promise.withResolvers<
        StructuredAgentSessionWriteOutcome<AgentSessionConversationCommandResult>
      >()
    const { runConversationCommand } = structuredConversationCommandRunner({
      agentName: 'Codex',
      pending: { current: false },
      commandsWait: false,
      chat: {
        turnId: null,
        isWorking: false,
        queueSendsNext: false,
        backgroundTasks: { isMonitoring: false, show: false },
        submissions: []
      },
      prompts: [],
      rewindInFlight: { current: false },
      sends: [],
      items: () => [],
      send: () => host.promise
    })
    const transport: NativeChatStructuredComposerTransport = {
      capturePresentation: () => () => true,
      send: vi.fn(() => true),
      dispatchCommand: (text, onSent) =>
        dispatchStructuredAgentSessionComposerCommand(
          text,
          {
            agent: 'codex',
            snapshot: [],
            invokeAction: async () => true,
            setOption: async () => true,
            conversationCommands: ['compact'],
            runConversationCommand
          },
          onSent
        ),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: vi.fn(),
        invokeAction: vi.fn(),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: vi.fn(),
      runtime: 'local',
      sessionId: 'compact-draft',
      runtimeEnvironmentId: null
    }
    const hook = renderHook(() => {
      const draft = useNativeChatDraft(scope, () => false)
      const send = useNativeChatStructuredComposerSend({
        agent: 'codex',
        draftScopeKey: scope,
        imageAttachments: [],
        structuredTransport: transport,
        isComposing: () => false,
        clearSkillOrigin: () => {},
        setDraft: draft.setDraft,
        setCaret: () => {}
      })
      return { ...draft, send }
    })
    act(() => hook.result.current.setDraft('/compact'))
    let sending: Promise<boolean> | undefined
    act(() => {
      sending = hook.result.current.send('/compact', [])
    })
    await act(async () => {})
    return { host, hook, settled: () => act(async () => sending) }
  }

  it('clears /compact while the host is still answering', async () => {
    const { host, hook, settled } = await sendCompactWhileHostAnswers()
    expect(hook.result.current.draft).toBe('')
    host.resolve({ kind: 'done', value: { command: 'compact', state: 'completed' } })
    await settled()
    expect(hook.result.current.draft).toBe('')
  })

  it('keeps a command typed while a refused /compact was answering', async () => {
    const { host, hook, settled } = await sendCompactWhileHostAnswers()
    act(() => hook.result.current.setDraft('/clear'))
    host.resolve({
      kind: 'not-done',
      notice: 'Codex could not compact.',
      failure: { kind: 'failed' }
    })
    await settled()
    expect(readNativeChatComposerDraft(scope).text).toBe('/clear')
  })
})
