// @vitest-environment happy-dom
import {
  rpc,
  main,
  storage,
  POSITION_TEXT,
  openPositionDraft,
  PositionField
} from './structured-agent-session-draft-position.test-fixture'
import { act, render, renderHook, within, fireEvent } from '@testing-library/react'
import { createRef, StrictMode } from 'react'
import type { NativeChatComposerInput } from '@/components/native-chat/native-chat-composer-input'
import { promptEditor } from '@/components/native-chat/native-chat-prompt-editor.test-support'
import { appendNativeChatDraftCache } from '@/components/native-chat/native-chat-draft-cache'
import { expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { adoptAgentSessionLaunchVerdict } from '../agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import {
  getStructuredLaunchStateBySessionId,
  hasStructuredAgentSessionLaunchCancellationTombstone
} from './launch/structured-agent-session-launch-registry'
import { hasStagedStructuredLaunchPrompt } from '../structured-agent-session-launch-prompt'
import { wasStructuredAgentLaunchClosedByLocalCancel } from '../structured-agent-session-local-launch-cancel'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import {
  clearNativeChatComposerDraftsForTests,
  flushNativeChatComposerDrafts,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import { setNativeChatComposerDraftStorageForTests } from '@/components/native-chat/native-chat-composer-draft-storage'
import {
  addNativeChatPendingAttachment,
  nativeChatPendingAttachmentSnapshot
} from '@/components/native-chat/native-chat-pending-attachment-cache'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import { useNativeChatDraft } from '@/components/native-chat/use-native-chat-draft'
import { openStructuredAgentSessionProvisionalTab } from '../structured-agent-session-launch-surface'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import {
  handBackStructuredAgentSessionMessage,
  returnMessageToComposer
} from '@/components/native-chat/structured-agent-session-message-hand-back'
import { CreateIntentParams } from '../../../../shared/rpc-contract/structured-agent-session-params'
it.each(['close', 'cancel', 'abort', 'edited-close'] as const)(
  'keeps a nonresume Hand Off through actual %s and late create settlement',
  async (action) => {
    const creation = Promise.withResolvers<unknown>()
    rpc.call.mockImplementation((_target, method) => {
      if (method === 'agentSession.create') {
        return creation.promise
      }
      if (method === 'agentSession.createSupport') {
        return Promise.resolve({ supported: true })
      }
      if (method === 'agentSession.close') {
        return Promise.resolve({ ok: true })
      }
      throw new Error(`Unexpected provider operation ${method}`)
    })
    const controller = new AbortController()
    const text = 'Hand Off context\nwith exact trailing bytes  '
    const plan = adoptAgentSessionLaunchVerdict({
      requestId: `early-${action}`,
      route: 'structured-native-chat',
      agent: 'claude',
      worktreeId: 'wt-1',
      executionHostId: 'local',
      prompt: text,
      promptDelivery: 'draft'
    })
    const handle = beginStructuredAgentSessionProvisionalLaunch({
      plan,
      hooks: { signal: controller.signal },
      focusIntent: { request: vi.fn(), cancel: vi.fn() }
    })
    if (!handle?.tab) {
      throw new Error('Expected a provisional source')
    }
    const { tab } = handle
    const scope = structuredAgentSessionDraftScopeKey(handle.sessionId)
    await main.settle()
    await vi.waitFor(() =>
      expect(rpc.call.mock.calls.some(([, method]) => method === 'agentSession.create')).toBe(true)
    )
    const params = CreateIntentParams.parse(
      rpc.call.mock.calls.find(([, method]) => method === 'agentSession.create')?.[2]
    )
    expect(params.resumeFrom).toBeUndefined()
    expect(params.firstMessage).toBeUndefined()
    expect(hasStagedStructuredLaunchPrompt(handle.sessionId)).toBe(false)
    expect(readNativeChatComposerDraft(scope)).toMatchObject({
      text,
      document: promptTextContent(text),
      owner: { workspaceId: 'wt-1', executionHostId: 'local' }
    })
    const edited = action === 'edited-close'
    const expectedText = edited ? 'my later text' : text
    const expectedDocument = edited
      ? { ...promptTextContent(expectedText), attrs: { edited: true } }
      : promptTextContent(text)
    if (edited) {
      updateNativeChatComposerDraft(
        scope,
        {
          text: expectedText,
          document: expectedDocument,
          images: [{ id: 'kept', path: '/repo/kept.png' }]
        },
        'immediate'
      )
      addNativeChatPendingAttachment(scope, { id: 'pending', path: '', pending: true })
    }
    if (action === 'cancel') {
      handle.cancel()
    } else if (action === 'abort') {
      controller.abort()
    } else {
      useAppStore.getState().closeUnifiedTab(tab.id)
    }
    await main.settle()
    const remainingIds = (useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []).map(
      (row) => row.id
    )
    expect(readNativeChatComposerDraft(scope).text).toBe(expectedText)
    expect(readNativeChatComposerDraft(scope).document).toEqual(expectedDocument)
    expect(
      ORCA_LAYOUT_OWNER_IS_MAIN
        ? wasStructuredAgentLaunchClosedByLocalCancel(handle.sessionId)
        : hasStructuredAgentSessionLaunchCancellationTombstone('wt-1', handle.sessionId)
    ).toBe(true)
    creation.resolve({
      ok: true,
      value: { sessionId: handle.sessionId, fence: 1, page: { submissions: [] } }
    })
    expect((await handle.settlement).kind).not.toBe('structured')
    await main.settle()
    expect(getStructuredLaunchStateBySessionId(handle.sessionId)).toBeUndefined()
    expect(
      (useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []).map((row) => row.id)
    ).toEqual(remainingIds)
    if (action.endsWith('close')) {
      expect(useAppStore.getState().getTab(tab.id)).toBeNull()
    }
    expect(
      rpc.call.mock.calls.filter(([, method]) => method === 'agentSession.create')
    ).toHaveLength(1)
    expect(
      rpc.call.mock.calls.every(
        ([, method]) =>
          method === 'agentSession.create' ||
          method === 'agentSession.close' ||
          method === 'agentSession.createSupport'
      )
    ).toBe(true)
    if (edited) {
      expect(nativeChatPendingAttachmentSnapshot(scope)).toHaveLength(1)
    }
    await nativeChatComposerDraftWritesSettled()
    expect(storage.drafts.get(scope)).toMatchObject({
      text: expectedText,
      document: expectedDocument,
      owner: { workspaceId: 'wt-1', executionHostId: 'local' }
    })
    clearNativeChatComposerDraftsForTests()
    setNativeChatComposerDraftStorageForTests(storage)
    await hydrateNativeChatComposerDrafts()
    const reader = renderHook(() => useNativeChatDraft(scope, () => false))
    expect(reader.result.current.draft).toBe(expectedText)
    expect(readNativeChatComposerDraft(scope).document).toEqual(expectedDocument)
    if (edited) {
      expect(readNativeChatComposerDraft(scope).images).toEqual([
        { id: 'kept', path: '/repo/kept.png' }
      ])
    }
    reader.unmount()
    await act(async () => {})
  }
)

it.each(['before', 'mounted', 'delayed-disabled', 'metadata', 'ordinary', 'replaced'] as const)(
  'installs the exact production draft and native position under StrictMode: %s',
  async (schedule) => {
    const input = createRef<NativeChatComposerInput>()
    let scope = 'agent-session:ordinary-position',
      tabId = 'ordinary'
    let view: ReturnType<typeof render> | undefined
    const mount = () =>
      render(
        <StrictMode>
          <div hidden={schedule === 'delayed-disabled'}>
            <PositionField
              scope={scope}
              input={input}
              tabId={tabId}
              disabled={schedule === 'delayed-disabled'}
            />
          </div>
        </StrictMode>
      )
    if (schedule === 'mounted') {
      const uuid = '11111111-2222-4333-8444-555555555555'
      vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
      const id = `claude_${uuid.replaceAll('-', '_')}`
      scope = structuredAgentSessionDraftScopeKey(id)
      tabId = structuredAgentSessionTabId(id)
      view = mount()
      await act(async () => {
        openPositionDraft()
        await main.settle()
      })
    } else if (schedule === 'ordinary') {
      updateNativeChatComposerDraft(
        scope,
        { text: POSITION_TEXT, document: promptTextContent(POSITION_TEXT) },
        'immediate'
      )
    } else {
      const handle = openPositionDraft()
      scope = structuredAgentSessionDraftScopeKey(handle.sessionId)
      tabId = handle.tab.id
      if (schedule === 'metadata') {
        updateNativeChatComposerDraft(
          scope,
          { images: [{ id: 'image', path: '/image.png' }] },
          'immediate'
        )
      }
      if (schedule === 'replaced') {
        updateNativeChatComposerDraft(
          scope,
          { text: `${POSITION_TEXT}changed`, document: undefined },
          'immediate'
        )
      }
      if (schedule === 'delayed-disabled') {
        // ast-grep-ignore: test-no-real-time-wait-tsx -- Cross the former 1s expiry before hidden/disabled attachment.
        await new Promise((resolve) => setTimeout(resolve, 1050))
      }
    }
    view ??= mount()
    const expected = schedule === 'replaced' ? `${POSITION_TEXT}changed` : POSITION_TEXT
    const end = !['ordinary', 'replaced'].includes(schedule)
    expect(input.current!.value).toBe(expected)
    expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual(
      end ? [expected.length, expected.length] : [0, 0]
    )
    const editor = promptEditor(within(view.container).getByRole('textbox', { hidden: true }))
    expect(editor.state.selection.from).toBe(end ? editor.state.doc.content.size - 1 : 1)
    if (schedule !== 'delayed-disabled') {
      act(() => input.current!.insertText!('!'))
      expect(input.current!.value).toBe(end ? `${expected}!` : `!${expected}`)
    }
    act(() => input.current!.setSelectionRange(2, 5))
    view.rerender(
      <StrictMode>
        <div>
          <PositionField scope={scope} input={input} tabId={tabId} />
        </div>
      </StrictMode>
    )
    act(() => input.current!.focus())
    expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([2, 5])
    view.unmount()
  }
)

it.each(['plain', 'rich', 'append'] as const)(
  'delivers a genuinely late saved load without taking newer ownership: %s',
  async (kind) => {
    const scope = 'agent-session:late-position',
      input = createRef<NativeChatComposerInput>()
    clearNativeChatComposerDraftsForTests()
    const loaded = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    setNativeChatComposerDraftStorageForTests({ ...storage, loadAll: () => loaded.promise })
    const loading = hydrateNativeChatComposerDrafts()
    const view = render(
      <StrictMode>
        <PositionField scope={scope} input={input} />
      </StrictMode>
    )
    const field = within(view.container).getByRole('textbox')
    if (kind === 'append') {
      act(() => appendNativeChatDraftCache(scope, 'newer'))
    }
    // ast-grep-ignore: test-no-real-time-wait-tsx -- Release the actual saved load after the 1500ms startup wait.
    await new Promise((resolve) => setTimeout(resolve, 1550))
    const document =
      kind === 'rich'
        ? {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [
                  { type: 'nativeChatSkill', attrs: { token: '$review', path: '/review' } },
                  { type: 'text', text: ' context  ' }
                ]
              }
            ]
          }
        : undefined
    const text =
      kind === 'rich'
        ? '$review context  '
        : kind === 'append'
          ? 'Hand Off\ncontext'
          : POSITION_TEXT
    await act(async () => {
      loaded.resolve(
        new Map([[scope, { text, images: [], savedAt: 1, ...(document ? { document } : {}) }]])
      )
      await loading
    })
    if (kind === 'plain' || kind === 'rich') {
      expect(input.current!.value).toBe(text)
      expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([0, 0])
      if (document) {
        expect(promptEditor(field).getJSON()).toEqual(document)
      }
    } else if (kind === 'append') {
      expect(input.current!.value).toBe(`${text}\n\nnewer`)
      expect(input.current!.selectionStart).toBeGreaterThan(0)
    }
    view.unmount()
  }
)

it.each(['close-before-attach', 'consumed-remount', 'sibling-first'] as const)(
  'uses the actual destination lifetime without changing its ordinary draft: %s',
  async (schedule) => {
    const handle = openPositionDraft(),
      scope = structuredAgentSessionDraftScopeKey(handle.sessionId)
    await main.settle()
    await vi.waitFor(() =>
      expect(rpc.call.mock.calls.some(([, method]) => method === 'agentSession.create')).toBe(true)
    )
    await handle.finish()
    const original = readNativeChatComposerDraft(scope)
    const input = createRef<NativeChatComposerInput>()
    const mount = (tabId = handle.tab.id) =>
      render(
        <StrictMode>
          <PositionField scope={scope} input={input} tabId={tabId} />
        </StrictMode>
      )
    if (schedule === 'close-before-attach') {
      useAppStore.getState().closeUnifiedTab(handle.tab.id)
      await main.settle()
      openStructuredAgentSessionProvisionalTab({
        worktreeId: 'wt-1',
        executionHostId: 'local',
        sessionId: handle.sessionId,
        agent: 'claude'
      })
      await main.settle()
      expect(useAppStore.getState().getTab(handle.tab.id)?.entityId).toBe(handle.sessionId)
    } else if (schedule === 'consumed-remount') {
      const first = mount()
      expect(input.current!.selectionStart).toBe(POSITION_TEXT.length)
      first.unmount()
    } else {
      const sibling = mount('other-tab')
      expect(input.current!.selectionStart).toBe(0)
      sibling.unmount()
    }
    const view = mount()
    expect(input.current!.value).toBe(POSITION_TEXT)
    expect(input.current!.selectionStart).toBe(
      schedule === 'sibling-first' ? POSITION_TEXT.length : 0
    )
    expect(readNativeChatComposerDraft(scope)).toBe(original)
    view.unmount()
  }
)

it.each(['range', 'edit', 'ime'] as const)(
  'keeps substantive native %s ahead of a held saved load and permits another restored editor',
  async (kind) => {
    const scope = 'agent-session:user-before-load',
      input = createRef<NativeChatComposerInput>(),
      other = createRef<NativeChatComposerInput>()
    clearNativeChatComposerDraftsForTests()
    const loaded = Promise.withResolvers<ReadonlyMap<string, unknown>>()
    setNativeChatComposerDraftStorageForTests({ ...storage, loadAll: () => loaded.promise })
    const loading = hydrateNativeChatComposerDrafts()
    const first = render(
      <StrictMode>
        <PositionField scope={scope} input={input} />
      </StrictMode>
    )
    const field = within(first.container).getByRole('textbox')
    await storage.write(scope, { text: 'typed before load', images: [], savedAt: 1 })
    const channel = new BroadcastChannel('orca-native-chat-composer-drafts')
    channel.postMessage({ scopeKey: scope })
    await act(async () => {
      await vi.waitFor(() => expect(input.current!.value).toBe('typed before load'))
    })
    channel.close()
    if (kind !== 'range') {
      act(() => {
        input.current!.setSelectionRange(0, 0)
        input.current!.insertText!('!')
      })
    }
    act(() => input.current!.setSelectionRange(2, 5))
    const before = promptEditor(field).getJSON()
    const saved = {
      text: POSITION_TEXT,
      images: [],
      savedAt: 1,
      document: promptTextContent(POSITION_TEXT)
    }
    await act(async () => {
      loaded.resolve(
        new Map([
          [scope, saved],
          ['agent-session:eligible', saved]
        ])
      )
      await loading
    })
    if (kind === 'ime') {
      fireEvent.compositionEnd(field, { data: 'typed' })
    }
    expect(input.current!.value).toBe(kind === 'range' ? POSITION_TEXT : '!typed before load')
    expect(promptEditor(field).getJSON()).toEqual(
      kind === 'range' ? promptTextContent(POSITION_TEXT) : before
    )
    expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([2, 5])
    first.unmount()
    const eligible = render(
      <StrictMode>
        <PositionField scope="agent-session:eligible" input={input} />
        <PositionField scope="agent-session:eligible" input={other} />
      </StrictMode>
    )
    expect([input.current!.selectionStart, other.current!.selectionStart]).toEqual([0, 0])
    act(() => input.current!.setSelectionRange(2, 5))
    expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([2, 5])
    expect(other.current!.selectionStart).toBe(0)
    eligible.unmount()
    const remount = render(<PositionField scope={scope} input={input} />)
    expect(input.current!.value).toBe(kind === 'range' ? POSITION_TEXT : '!typed before load')
    expect(input.current!.selectionStart).toBe(0)
    remount.unmount()
  }
)

it('uses actual no-focus Hand Off host admission, seed, open and create settlement without reauthoring on repeat', async () => {
  const creation = Promise.withResolvers<unknown>()
  rpc.call.mockImplementation((_target, method) =>
    Promise.resolve(
      method === 'agentSession.createSupport'
        ? { supported: true }
        : method === 'agentSession.create'
          ? creation.promise
          : { ok: true }
    )
  )
  const plan = adoptAgentSessionLaunchVerdict({
    requestId: 'no-focus',
    route: 'structured-native-chat',
    agent: 'claude',
    worktreeId: 'wt-1',
    executionHostId: 'local',
    prompt: POSITION_TEXT,
    promptDelivery: 'draft'
  })
  const launch = beginStructuredAgentSessionProvisionalLaunch({ plan, hooks: {} })
  if (!launch) {
    throw new Error('Expected admission')
  }
  expect(launch.tab).toBeNull()
  await vi.waitFor(() =>
    expect(rpc.call.mock.calls.some(([, method]) => method === 'agentSession.create')).toBe(true)
  )
  const params = CreateIntentParams.parse(
    rpc.call.mock.calls.find(([, method]) => method === 'agentSession.create')?.[2]
  )
  expect(params.firstMessage).toBeUndefined()
  const tab = (useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []).find(
    (tab) => tab.contentType === 'agent-session'
  )
  if (!tab) {
    throw new Error('Expected admitted tab')
  }
  creation.resolve({
    ok: true,
    value: { sessionId: tab.entityId, fence: 1, page: { submissions: [] } }
  })
  await launch.settlement
  await main.settle()
  const scope = structuredAgentSessionDraftScopeKey(tab.entityId),
    original = readNativeChatComposerDraft(scope),
    input = createRef<NativeChatComposerInput>()
  const mount = () =>
    render(
      <StrictMode>
        <PositionField scope={scope} tabId={tab.id} input={input} />
      </StrictMode>
    )
  const first = mount()
  expect(input.current!.value).toBe(POSITION_TEXT)
  expect(input.current!.selectionStart).toBe(POSITION_TEXT.length)
  act(() => input.current!.setSelectionRange(2, 5))
  openStructuredAgentSessionProvisionalTab({
    worktreeId: 'wt-1',
    executionHostId: 'local',
    sessionId: tab.entityId,
    agent: 'claude'
  })
  await main.settle()
  expect(readNativeChatComposerDraft(scope)).toBe(original)
  expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([2, 5])
  first.unmount()
  const second = mount()
  expect(input.current!.selectionStart).toBe(0)
  second.unmount()
  expect(
    rpc.call.mock.calls.filter(([, method]) => method === 'agentSession.createSupport')
  ).toHaveLength(2)
})

it('keeps genuine handback and foreign adoption on their ordinary native mapping', async () => {
  const scope = 'agent-session:controls',
    input = createRef<NativeChatComposerInput>()
  updateNativeChatComposerDraft(scope, { text: 'original' }, 'immediate')
  const view = render(
    <StrictMode>
      <PositionField scope={scope} input={input} />
    </StrictMode>
  )
  act(() => input.current!.setSelectionRange(2, 5))
  act(() =>
    expect(
      handBackStructuredAgentSessionMessage('controls', 'one', {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'returned' }]
      })
    ).toBe(true)
  )
  expect(input.current!.value).toBe('original\n\nreturned')
  expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([2, 5])
  act(() =>
    expect(returnMessageToComposer(scope, 'two', [{ type: 'text', text: 'second' }])).toBe(true)
  )
  expect(input.current!.value).toBe('original\n\nreturned\n\nsecond')
  expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([26, 26])
  await nativeChatComposerDraftWritesSettled()
  flushNativeChatComposerDrafts()
  await nativeChatComposerDraftWritesSettled()
  await storage.write(scope, { text: 'foreign replacement', images: [], savedAt: 100 })
  const channel = new BroadcastChannel('orca-native-chat-composer-drafts')
  channel.postMessage({ scopeKey: scope })
  await act(async () => {
    await vi.waitFor(() => expect(input.current!.value).toBe('foreign replacement'))
  })
  expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([19, 19])
  channel.close()
  view.unmount()
})

it.each(['edit', 'ime'] as const)(
  'lets genuine native %s win between accepted seed and actual adoption, without replay on remount',
  async (kind) => {
    const uuid = '11111111-2222-4333-8444-555555555555'
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(uuid)
    const id = `claude_${uuid.replaceAll('-', '_')}`,
      scope = structuredAgentSessionDraftScopeKey(id),
      input = createRef<NativeChatComposerInput>()
    const mount = () =>
      render(
        <StrictMode>
          <PositionField scope={scope} tabId={structuredAgentSessionTabId(id)} input={input} />
        </StrictMode>
      )
    const first = mount(),
      field = within(first.container).getByRole('textbox')
    await act(async () => {
      openPositionDraft()
      if (kind === 'ime') {
        fireEvent.compositionStart(field)
      }
      input.current!.insertText!('native wins  ')
      input.current!.setSelectionRange(2, 5)
      if (kind === 'ime') {
        fireEvent.compositionEnd(field, { data: 'native wins  ' })
      }
      await main.settle()
    })
    expect(input.current!.value).toBe('native wins  ')
    expect([input.current!.selectionStart, input.current!.selectionEnd]).toEqual([2, 5])
    expect(promptEditor(field).getJSON()).toEqual(promptTextContent('native wins  '))
    first.unmount()
    const second = mount()
    expect(input.current!.value).toBe('native wins  ')
    expect(input.current!.selectionStart).toBe(0)
    second.unmount()
  }
)
