// @vitest-environment happy-dom
import { harness, begin, message, script, withText } from './structured-queued-edit.test-fixture'
import { countedQueuedEditPublication } from '../../../../shared/queued-edit-publication.test-fixture'
import * as publication from '../../../../shared/queued-message-edit-publication'
import * as eligibility from '../../../../shared/queued-message-edit-command'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatComposerCommandPicker } from './use-native-chat-composer-command-picker'
import type { NativeChatComposerInput } from './native-chat-composer-input'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { AgentType } from '../../../../shared/agent-status-types'
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], retry: () => {} })
}))
afterEach(() => vi.restoreAllMocks())
it.each([10, 100])(
  'actual edit hook bounds publication-key reads with %i fresh Q/C/R rows',
  async (n) => {
    const counter = countedQueuedEditPublication()
    vi.spyOn(publication, 'queuedEditPublicationKey').mockImplementation(counter.key)
    const rows = () => [
      ...Array.from({ length: n - 1 }, (_, i) => ({ ...message, messageId: `other-${i}` })),
      message
    ]
    const submissions = () =>
      Array.from({ length: n }, (_, i) => ({
        clientMessageId: `s${i}`,
        queuedMessageId: `unused-${i}`,
        fence: 1,
        payloadFingerprint: 'other',
        dispatchState: 'pending' as const,
        providerItemId: null,
        reason: null,
        submittedAt: 1,
        resolvedAt: null
      }))
    const hook = harness(true, { messages: rows(), submissions: submissions() })
    hook.rerender({ messages: rows(), submissions: submissions() })
    expect(counter.reads).toBe(0)
    await begin(hook)
    counter.reset()
    hook.rerender({ messages: rows(), submissions: submissions() })
    expect(counter.reads).toBeGreaterThanOrEqual(3 * n)
    expect(counter.reads).toBeLessThanOrEqual(3 * n + 2)
    expect(hook.result.current.editor).toBeDefined()
    act(() => hook.result.current.editor!.change('saved'))
    script.answer = async () => ({
      kind: 'not-done',
      notice: 'unknown',
      failure: { kind: 'unconfirmed' }
    })
    act(() => hook.result.current.editor!.save())
    await waitFor(() => expect(hook.result.current.editor?.saving).toBe(false))
    counter.reset()
    hook.rerender({
      messages: [...rows().slice(0, -1), withText('saved')],
      submissions: submissions()
    })
    expect(counter.reads).toBeLessThanOrEqual(3 * n + 2)
    expect(hook.result.current.editor).toBeUndefined()
  }
)
it.each([10, 100])(
  'actual desktop menu prepares eligibility once per generation for %i reported rows',
  (n) => {
    const prepare = vi.spyOn(eligibility, 'prepareQueuedMessageEditText')
    const reported = () =>
      Array.from({ length: n }, (_, i) => ({ name: `provider-${i}`, kind: 'command' as const }))
    const transport: NativeChatStructuredComposerTransport = {
      capturePresentation: () => () => true,
      send: () => true,
      dispatchCommand: async () => ({ handled: false, accepted: false, error: null }),
      optionsSurface: {
        getSnapshot: () => [],
        setOption: async () => ({ snapshot: [] }),
        invokeAction: async () => ({ snapshot: [] }),
        subscribe: () => () => {}
      },
      optionSnapshot: [],
      onError: () => {},
      runtime: 'local',
      sessionId: 's',
      worktreeId: 'wt',
      runtimeEnvironmentId: null,
      sessionCommands: reported()
    }
    const hook = renderHook(
      ({
        draft,
        agent,
        editing,
        target
      }: {
        draft: string
        agent: AgentType
        editing: boolean
        target: typeof transport
      }) => {
        const textareaRef = useRef<NativeChatComposerInput>(null)
        return useNativeChatComposerCommandPicker({
          agent,
          terminalTabId: 'tab',
          draftScopeKey: 'scope',
          draft,
          caret: draft.length,
          recalledFromHistory: false,
          disabled: false,
          isComposing: () => false,
          editor: {
            textareaRef,
            setDraft: () => {},
            setCaret: () => {},
            setActiveSuggestion: () => {}
          },
          structuredTransport: target,
          editing,
          setNotice: () => {}
        })
      },
      {
        initialProps: { draft: '', agent: 'claude', editing: true, target: transport }
      }
    )
    expect(prepare).toHaveBeenCalledTimes(1)
    for (const draft of ['/', '/p', '/provider', '/provider-9']) {
      hook.rerender({ draft, agent: 'claude', editing: true, target: transport })
    }
    expect(prepare).toHaveBeenCalledTimes(1)
    hook.rerender({ draft: '/', agent: 'claude', editing: false, target: transport })
    expect(prepare).toHaveBeenCalledTimes(1)
    hook.rerender({
      draft: '/',
      agent: 'claude',
      editing: true,
      target: { ...transport, sessionCommands: reported() }
    })
    expect(prepare).toHaveBeenCalledTimes(2)
    const goal = { ...transport, threadGoal: { setObjective: async () => true } }
    hook.rerender({ draft: '/', agent: 'claude', editing: true, target: goal })
    expect(prepare).toHaveBeenCalledTimes(3)
    hook.rerender({
      draft: '/',
      agent: 'claude',
      editing: true,
      target: { ...goal, threadGoal: { setObjective: async () => false } }
    })
    expect(prepare).toHaveBeenCalledTimes(3)
    hook.rerender({ draft: '/', agent: 'codex', editing: true, target: goal })
    expect(prepare).toHaveBeenCalledTimes(4)
  }
)
