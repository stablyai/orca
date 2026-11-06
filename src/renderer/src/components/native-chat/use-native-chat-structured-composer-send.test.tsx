// @vitest-environment happy-dom
// @vitest-environment happy-dom

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
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/agent-session/view/structured-agent-session-composer'

import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))

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
import { adoptIdentifiedNativeChatDraftInput } from './native-chat-composer-draft-handback'
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

  it('keeps a sent returned message consumed while its receipt is owed, through an unload and a cold reload', async () => {
    const fixture = acceptanceFixture()
    const receipt = { operationId: 'op-sent', clientMessageId: 'msg-sent' }
    const returnedText = 'Inspect the failing test and fix it'
    adoptIdentifiedNativeChatDraftInput(scope, receipt, { text: returnedText, images: [] }, [])
    await nativeChatComposerDraftWritesSettled()
    const backend = nativeChatComposerDraftStorage() as ReturnType<
      typeof createMemoryNativeChatComposerDraftStorage
    >
    // From here the draft's commits are refused: only the journal can carry what Send leaves.
    backend.refuseWrites = true
    const hook = fixture.mount()
    await act(async () => hook.result.current.send(hook.result.current.draft, []))
    expect(fixture.transport.send).toHaveBeenCalledWith(returnedText, [])
    expect(readNativeChatComposerDraft(scope).text).toBe('')
    await nativeChatComposerDraftWritesSettled()
    window.dispatchEvent(new Event('pagehide'))
    hook.unmount()
    // What Send left is journaled as content consumed with the receipt still owed, and the same
    // return is not taken again.
    const journal = JSON.parse(
      localStorage.getItem('orca:nativeChatComposerDraftJournal:v1') ?? '[]'
    )
    expect(journal).toEqual([
      expect.objectContaining({
        scopeKey: scope,
        draft: expect.objectContaining({ text: '', images: [], handbacks: [receipt] })
      })
    ])
    expect(
      adoptIdentifiedNativeChatDraftInput(scope, receipt, { text: returnedText, images: [] }, [])
    ).toEqual({ adopted: false })
    expect(readNativeChatComposerDraft(scope).text).toBe('')

    // A cold renderer replays that disposition over the older committed message.
    clearNativeChatComposerDraftsForTests()
    backend.refuseWrites = false
    setNativeChatComposerDraftStorageForTests(backend)
    await hydrateNativeChatComposerDrafts()
    await nativeChatComposerDraftWritesSettled()
    expect(readNativeChatComposerDraft(scope).text).toBe('')
    expect(backend.drafts.get(scope)?.text ?? '').toBe('')
  })
})
