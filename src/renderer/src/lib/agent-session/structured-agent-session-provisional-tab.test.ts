// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type * as launchModule from '../structured-agent-session-launch-create-call'
import type { AgentSessionLaunchPlan } from '../agent-session-launch-plan'
import { adoptAgentSessionLaunchVerdict } from '../agent-session-launch-plan'
import { beginStructuredAgentSessionProvisionalLaunch } from './structured-agent-session-provisional-tab'
import { StructuredAgentSessionCreateRefusalError } from '../structured-agent-session-launch-errors'
import { act, renderHook } from '@testing-library/react'
import { useNativeChatProvisionalLaunch } from '@/components/native-chat/use-native-chat-provisional-launch'
import {
  getStructuredAgentSessionLaunchFailure,
  getStructuredLaunchStateBySessionId,
  hasStructuredAgentSessionLaunchCancellationTombstone,
  resetStructuredAgentLaunchRegistryForTests
} from './launch/structured-agent-session-launch-registry'
import { structuredSessionNotices } from '@/components/native-chat/native-chat-structured-session-notices'
import type { AgentTerminalLaunchCompletion } from '../structured-agent-session-launch-admission'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot
} from '@/components/native-chat/native-chat-pending-attachment-cache'
import { applyStructuredSessionTabSnapshots } from '@/runtime/local-structured-session-tabs-sync/snapshot-apply'
import { makeEmptyHostSnapshot } from '@/runtime/host-session-mirror-frame-fixtures'
import * as unlisted from '../structured-agent-session-unlisted-created-chats'
import { buildFullWorktreePurgeState } from '@/store/slices/worktrees/teardown/worktree-purge-state'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import { structuredAgentSessionTabId } from '../../../../shared/structured-agent-session-projection'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

const mocks = vi.hoisted(() => ({ focus: vi.fn(), toast: vi.fn(), launch: vi.fn() }))
vi.mock('../structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof launchModule>()),
  launchStructuredAgentSession: mocks.launch
}))
vi.mock('sonner', () => ({ toast: { info: mocks.toast, error: vi.fn() } }))
vi.mock('../focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import { restorePersistedStructuredLaunchState } from './launch/structured-agent-session-launch-reload'
import { promptTextContent } from '@/components/native-chat/native-chat-prompt-document-text'
import { useNativeChatDraft } from '@/components/native-chat/use-native-chat-draft'
import { wasStructuredAgentLaunchClosedByLocalCancel } from '../structured-agent-session-local-launch-cancel'
import {
  startStructuredAgentLaunch,
  retryStructuredAgentSessionLaunch
} from '../structured-agent-session-launch'
import { assertProvisionalSelectionLifetime } from './structured-agent-session-provisional-selection-lifetime.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { openStructuredAgentSessionProvisionalTab } from '../structured-agent-session-launch-surface'
import { markStructuredAgentSessionLaunchPublished } from './launch/structured-agent-session-launch-publication'

function terminalRecord(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

let refuse = (): void => {}
let accept: (receipt: Awaited<ReturnType<typeof launchModule.launchStructuredAgentSession>>) => void

function planSettlingAs(
  error: StructuredAgentSessionCreateRefusalError,
  prompt = 'hand-off context',
  resume = false
): AgentSessionLaunchPlan {
  const creation = new Promise<
    Awaited<ReturnType<typeof launchModule.launchStructuredAgentSession>>
  >((resolve, reject) => {
    refuse = () => reject(error)
    accept = resolve
  })
  mocks.launch.mockReturnValue(creation)
  return adoptAgentSessionLaunchVerdict({
    requestId: 'action',
    route: 'structured-native-chat',
    agent: 'claude',
    worktreeId: 'wt-1',
    executionHostId: 'local',
    prompt,
    ...(resume ? { resumeFrom: { providerSessionId: 'prior-chat' } } : {}),
    promptDelivery: 'draft'
  })
}

let main: TabsDrawnFromMain
let draftStorage: ReturnType<typeof createMemoryNativeChatComposerDraftStorage>

beforeEach(async () => {
  vi.clearAllMocks()
  clearNativeChatComposerDraftsForTests()
  draftStorage = createMemoryNativeChatComposerDraftStorage()
  setNativeChatComposerDraftStorageForTests(draftStorage)
  await hydrateNativeChatComposerDrafts()
  resetStructuredAgentLaunchRegistryForTests()
  clearNativeChatPendingAttachmentsForTests()
  useAppStore.setState({
    activeWorktreeId: 'wt-1',
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    tabsByWorktree: {},
    tabBarOrderByWorktree: {}
  })
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => main.close())

async function mainLoadsStoreLayout(): Promise<void> {
  main.close()
  main = await drawTabsFromMain(useAppStore)
}

function pinAsUser(tabId: string): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    useAppStore.getState().pinTab(tabId)
    return
  }
  const worktreeId = useAppStore.getState().getTab(tabId)?.worktreeId ?? 'wt-1'
  sendLayoutCommandToOwner(
    worktreeId,
    { type: 'setTabProps', tabId, isPinned: true },
    { apply: () => {}, asToday: () => useAppStore.getState().pinTab(tabId) }
  )
}

function labelAsUser(tabId: string, label: string, color: string): void {
  if (!ORCA_LAYOUT_OWNER_IS_MAIN) {
    useAppStore.getState().setTabCustomLabel(tabId, label)
    useAppStore.getState().setUnifiedTabColor(tabId, color)
    return
  }
  const asToday = { apply: () => {}, asToday: () => {} }
  sendLayoutCommandToOwner(
    'wt-1',
    { type: 'renameTab', tabId, kind: 'custom', title: label },
    asToday
  )
  sendLayoutCommandToOwner('wt-1', { type: 'setTabProps', tabId, color }, asToday)
}

function groupOf(tabId: string): string {
  const groupId = useAppStore.getState().getTab(tabId)?.groupId
  if (!groupId) {
    throw new Error(`No drawn tab ${tabId}`)
  }
  return groupId
}

function openChat(
  requestedSurface?: 'chat',
  signal?: AbortSignal,
  prompt = 'hand-off context',
  resume = false
) {
  let complete!: (value: AgentTerminalLaunchCompletion) => void
  const completion = new Promise<AgentTerminalLaunchCompletion>((resolve) => {
    complete = resolve
  })
  const fallback = vi.fn(() => ({ opened: true, completion }))
  const plan = {
    ...planSettlingAs(new StructuredAgentSessionCreateRefusalError('no'), prompt, resume),
    requestedSurface
  }
  const resumed = resume ? plan.begin({ signal }) : null
  const launch = resumed
    ? {
        ...resumed,
        tab: openStructuredAgentSessionProvisionalTab({
          worktreeId: 'wt-1',
          executionHostId: resumed.executionHostId,
          sessionId: resumed.sessionId,
          agent: 'claude'
        })
      }
    : beginStructuredAgentSessionProvisionalLaunch({
        plan,
        hooks: { signal },
        focusIntent: { request: mocks.focus, cancel: vi.fn() },
        onHostDeclined: fallback
      })
  const chat = launch?.tab
  if (!chat) {
    throw new Error('No immediate chat')
  }
  return { launch, chat, fallback, complete }
}

describe('a provisional structured chat tab', () => {
  it.each(['before', 'after'] as const)(
    'retains a draft initialized %s host publication through close and reopen',
    async (order) => {
      const { launch, chat } = openChat(
        'chat',
        undefined,
        order === 'after' ? '' : 'hand-off context',
        order === 'after'
      )
      await main.settle()
      const scope = structuredAgentSessionDraftScopeKey(chat.entityId)
      const pending = getStructuredLaunchStateBySessionId(chat.entityId)
      expect(markStructuredAgentSessionLaunchPublished('wt-1', chat.entityId, 'ssh:other')).toBe(
        false
      )
      expect(pending?.hostListed).not.toBe(true)
      applyStructuredSessionTabSnapshots([
        {
          ...makeEmptyHostSnapshot('wt-1'),
          publicationEpoch: chat.entityId,
          tabs: [
            {
              type: 'agent-session',
              id: structuredAgentSessionTabId(chat.entityId),
              sessionId: chat.entityId,
              agent: 'claude',
              title: 'Chat',
              isActive: true
            }
          ]
        }
      ])
      await main.settle()
      expect(pending?.hostListed).toBe(true)
      expect(pending?.callers.outcome).toBe('pending')
      expect(useAppStore.getState().getTab(chat.id)).not.toBeNull()
      const joined =
        order === 'after'
          ? startStructuredAgentLaunch('wt-1', 'claude', {
              requestId: 'later-action',
              prompt: 'hand-off context',
              promptDelivery: 'draft',
              resumeFrom: { providerSessionId: 'prior-chat' }
            })
          : undefined
      expect(joined?.joined ?? true).toBe(true)
      expect(readNativeChatComposerDraft(scope).text).toBe('hand-off context')

      useAppStore.getState().closeUnifiedTab(chat.id)
      await main.settle()
      expect(
        ORCA_LAYOUT_OWNER_IS_MAIN
          ? wasStructuredAgentLaunchClosedByLocalCancel(chat.entityId)
          : hasStructuredAgentSessionLaunchCancellationTombstone('wt-1', chat.entityId)
      ).toBe(true)
      accept({ sessionId: chat.entityId, fence: 1 })
      expect(pending?.cancelled).toBe(true)
      expect((await launch.settlement).kind).not.toBe('structured')
      await Promise.allSettled(joined ? [joined.launchResult] : [])
      await main.settle()
      expect(useAppStore.getState().getTab(chat.id)).toBeNull()
      expect(getStructuredLaunchStateBySessionId(chat.entityId)).toBeUndefined()
      await nativeChatComposerDraftWritesSettled()
      expect(draftStorage.drafts.get(scope)?.text).toBe('hand-off context')
      expect(draftStorage.drafts.get(scope)?.document).toEqual(
        promptTextContent('hand-off context')
      )

      clearNativeChatComposerDraftsForTests()
      setNativeChatComposerDraftStorageForTests(draftStorage)
      await hydrateNativeChatComposerDrafts()
      const reopened = useAppStore.getState().createUnifiedTab('wt-1', 'agent-session', {
        entityId: chat.entityId
      })
      await main.settle()
      const composer = renderHook(() =>
        useNativeChatDraft(structuredAgentSessionDraftScopeKey(reopened.entityId), () => false)
      )
      expect(composer.result.current.draft).toBe('hand-off context')
      composer.unmount()
    }
  )

  it('joins pending launch before uncertainty, then normalizes own success with held picks, Retry and close', async () => {
    const { launch, chat } = openChat('chat', undefined, '', true)
    await assertProvisionalSelectionLifetime({
      launch,
      chat,
      main,
      accept,
      launchCall: mocks.launch
    })
  })

  it.each(['cancel', 'abort', 'close', 'reloaded-close', 'silent'] as const)(
    'retains ordinary draft content during %s',
    async (action) => {
      const controller = new AbortController()
      const { launch, chat } = openChat('chat', controller.signal)
      await main.settle()
      const scope = structuredAgentSessionDraftScopeKey(chat.entityId)
      const text = action === 'cancel' ? 'new thought' : 'hand-off context'
      const document =
        action === 'close'
          ? { ...promptTextContent(text), attrs: { edited: true } }
          : promptTextContent(text)
      updateNativeChatComposerDraft(
        scope,
        { text, document, images: [{ id: 'image', path: '/repo/image.png' }] },
        'immediate'
      )
      addNativeChatPendingAttachment(scope, { id: 'pending', path: '', pending: true })
      if (action === 'reloaded-close') {
        await nativeChatComposerDraftWritesSettled()
        clearNativeChatComposerDraftsForTests()
        setNativeChatComposerDraftStorageForTests(draftStorage)
        await hydrateNativeChatComposerDrafts()
        resetStructuredAgentLaunchRegistryForTests()
        expect(restorePersistedStructuredLaunchState('wt-1', chat.entityId)).toBeDefined()
      }
      if (action === 'cancel') {
        launch.cancel()
      } else if (action === 'abort') {
        controller.abort()
      } else if (action === 'silent') {
        buildFullWorktreePurgeState(useAppStore.getState(), [{ id: 'wt-1' }])
      } else {
        useAppStore.getState().closeUnifiedTab(chat.id)
      }
      await main.settle()
      expect(readNativeChatComposerDraft(scope)).toMatchObject({
        text,
        images: [{ id: 'image' }]
      })
      expect(readNativeChatComposerDraft(scope).document).toEqual(document)
      expect(nativeChatPendingAttachmentSnapshot(scope)).toHaveLength(1)
      refuse()
      await launch.settlement
    }
  )

  it
    .skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)
    .each([
      'initializer',
      'published',
      'text',
      'document',
      'image',
      'pending',
      'pre-removed',
      'retry',
      'abort',
      'source-closed',
      'replacement-closed',
      'unplaced'
    ])('revalidates terminal takeover after main placement: %s', async (change) => {
    const controller = new AbortController()
    const { launch, chat, fallback, complete } = openChat(
      undefined,
      controller.signal,
      change === 'initializer' ? 'hand-off context' : ''
    )
    await main.settle()
    const scope = structuredAgentSessionDraftScopeKey(chat.entityId)
    if (change === 'pre-removed') {
      updateNativeChatComposerDraft(scope, { text: 'keep before' }, 'immediate')
    }
    refuse()
    await vi.waitFor(() => expect(fallback).toHaveBeenCalledOnce())
    const terminal = useAppStore.getState().createUnifiedTab('wt-1', 'terminal', {
      id: 'replacement',
      activate: false,
      split: { sourceGroupId: groupOf(chat.id), splitDirection: 'right', activate: false }
    })
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [terminalRecord(terminal.entityId)] } })
    await mainLoadsStoreLayout()
    layoutApplyTestTransport.answerWith((command) =>
      command.type === 'moveTab' ? 'pending' : 'apply'
    )
    complete({ outcome: { status: 'created' }, tabId: terminal.id })
    await vi.waitFor(() => expect(layoutApplyTestTransport.pendingCount).toBe(1))
    if (change === 'published') {
      markStructuredAgentSessionLaunchPublished('wt-1', chat.entityId, 'local')
    }
    if (change === 'text') {
      updateNativeChatComposerDraft(scope, { text: 'keep after', document: undefined }, 'immediate')
    }
    if (change === 'document') {
      updateNativeChatComposerDraft(
        scope,
        {
          text: 'hand-off context',
          document: { ...promptTextContent('hand-off context'), attrs: { edited: true } }
        },
        'immediate'
      )
    }
    if (change === 'image') {
      updateNativeChatComposerDraft(
        scope,
        { images: [{ id: 'image', path: '/repo/image.png' }] },
        'immediate'
      )
    }
    if (change === 'pending') {
      addNativeChatPendingAttachment(scope, { id: 'pending', path: '', pending: true })
    }
    if (change === 'pre-removed') {
      updateNativeChatComposerDraft(scope, { text: '', document: undefined }, 'immediate')
    }
    if (change === 'retry') {
      expect(retryStructuredAgentSessionLaunch('wt-1', chat.entityId)).toBe(true)
    }
    if (change === 'abort') {
      controller.abort()
    }
    if (change === 'source-closed') {
      useAppStore.getState().closeUnifiedTab(chat.id)
    }
    if (change === 'replacement-closed') {
      useAppStore.getState().closeUnifiedTab(terminal.id)
    }
    layoutApplyTestTransport.answerWith(
      change === 'unplaced' ? { refuse: 'tab_not_found' } : 'apply'
    )
    layoutApplyTestTransport.answerPending()
    const result = await launch.settlement
    await main.settle()
    expect(result.kind).not.toBe('terminal')
    expect(readNativeChatComposerDraft(scope).text).toBe(
      change === 'pre-removed'
        ? ''
        : change === 'text'
          ? 'keep after'
          : ['initializer', 'document'].includes(change)
            ? 'hand-off context'
            : ''
    )
    if (change !== 'source-closed' && change !== 'abort') {
      expect(useAppStore.getState().getTab(chat.id)).not.toBeNull()
    }
  })

  it.each([
    'empty',
    'typed-before',
    'typed-during',
    'initializer',
    'published-during',
    'image-during',
    'pending-chip',
    'failed',
    'unreconciled',
    'closed',
    'explicit',
    'away-before',
    'away-during',
    'closed-during'
  ])('owns the destination through terminal completion: %s', async (scenario) => {
    const { launch, chat, fallback, complete } = openChat(
      scenario === 'explicit' ? 'chat' : undefined,
      undefined,
      scenario === 'initializer' || scenario === 'explicit' ? 'hand-off context' : ''
    )
    const scope = structuredAgentSessionDraftScopeKey(chat.entityId)
    if (scenario === 'typed-before') {
      updateNativeChatComposerDraft(scope, { text: 'keep this', document: undefined }, 'immediate')
    }
    await main.settle()
    expect(mocks.focus).toHaveBeenCalledWith(chat.id)
    const view = renderHook(() => {
      const current = useNativeChatProvisionalLaunch('wt-1', chat.entityId)
      return structuredSessionNotices({
        launch: current,
        agentLabel: 'Claude',
        sessionError: null,
        composerError: null
      })
    })
    const away = () => {
      useAppStore.getState().createUnifiedTab('wt-2', 'agent-session', { entityId: 'other' })
      useAppStore.setState({ activeWorktreeId: 'wt-2', activeTabType: 'agent-session' })
    }
    if (scenario === 'away-before') {
      away()
    }
    if (scenario === 'closed') {
      useAppStore.getState().closeUnifiedTab(chat.id)
    }
    await main.settle()
    refuse()
    await vi.waitFor(() =>
      expect(
        scenario === 'closed' || scenario === 'explicit' || fallback.mock.calls.length
      ).toBeTruthy()
    )
    if (scenario === 'closed' || scenario === 'explicit') {
      await launch?.settlement
      expect(fallback).not.toHaveBeenCalled()
      view.unmount()
      return
    }
    expect(useAppStore.getState().unifiedTabsByWorktree['wt-1']).toContainEqual(
      expect.objectContaining({ ...chat, contentType: 'agent-session' })
    )
    // Move the source while its host is preparing the terminal, then invest in the composer.
    const sibling = useAppStore.getState().createUnifiedTab('wt-1', 'terminal', {
      entityId: 'sibling',
      split: { sourceGroupId: groupOf(chat.id), splitDirection: 'right', activate: true }
    })
    const groupId = sibling.groupId
    const siblingRecords = () =>
      ORCA_LAYOUT_OWNER_IS_MAIN ? [terminalRecord(sibling.entityId)] : []
    useAppStore.setState({ tabsByWorktree: { 'wt-1': siblingRecords() } })
    await mainLoadsStoreLayout()
    const pinnedSource = ['empty', 'typed-during', 'initializer'].includes(scenario)
    if (pinnedSource) {
      pinAsUser(chat.id)
      pinAsUser(sibling.id)
      labelAsUser(chat.id, 'My work', '#ff0000')
    }
    useAppStore.getState().moveUnifiedTabToGroup(chat.id, groupId)
    useAppStore.getState().reorderUnifiedTabs(groupId, [chat.id, sibling.id])
    if (scenario === 'typed-during') {
      updateNativeChatComposerDraft(
        scope,
        { text: 'new thought', document: undefined },
        'immediate'
      )
    }
    if (scenario === 'published-during') {
      markStructuredAgentSessionLaunchPublished('wt-1', chat.entityId, 'local')
    }
    if (scenario === 'image-during') {
      updateNativeChatComposerDraft(
        scope,
        { images: [{ id: 'image', path: '/repo/image.png' }] },
        'immediate'
      )
    }
    if (scenario === 'pending-chip') {
      addNativeChatPendingAttachment(`agent-session:${chat.entityId}`, {
        id: 'paste',
        path: '',
        pending: true
      })
    }
    if (scenario === 'away-during') {
      away()
    }
    if (scenario === 'closed-during') {
      useAppStore.getState().closeUnifiedTab(chat.id)
    }
    await main.settle()
    if (pinnedSource) {
      useAppStore.getState().activateTab(chat.id)
      useAppStore.getState().setActiveTabType('agent-session', 'wt-1')
    }
    const priorFailure = getStructuredAgentSessionLaunchFailure('wt-1', chat.entityId)
    const terminal =
      scenario === 'failed' || scenario === 'unreconciled'
        ? null
        : useAppStore
            .getState()
            .createUnifiedTab('wt-1', 'terminal', { id: 'replacement', activate: false })
    if (terminal) {
      useAppStore.setState({
        tabsByWorktree: { 'wt-1': [terminalRecord(terminal.entityId), ...siblingRecords()] }
      })
      if (scenario === 'typed-before') {
        useAppStore.getState().pinTab(terminal.id)
      }
    }
    await mainLoadsStoreLayout()
    const selected = useAppStore.getState().getActiveTab('wt-2')
    const interaction = vi.fn()
    useAppStore.setState({ recordFeatureInteraction: interaction })
    await act(async () => {
      complete({
        outcome:
          scenario === 'failed' ? { status: 'failed', message: 'offline' } : { status: 'created' },
        tabId: terminal?.id ?? 'missing'
      })
      await launch?.settlement
      await main.settle()
    })
    if (scenario !== 'closed-during') {
      expect(readNativeChatComposerDraft(scope).text).toBe(
        ['empty', 'away-before', 'away-during'].includes(scenario)
          ? ''
          : scenario === 'typed-before'
            ? 'keep this'
            : scenario === 'typed-during'
              ? 'new thought'
              : scenario === 'initializer'
                ? 'hand-off context'
                : ''
      )
    }
    expect(interaction).not.toHaveBeenCalled()
    const state = useAppStore.getState()
    const tabs = state.unifiedTabsByWorktree['wt-1'] ?? []
    expect(tabs.some((t) => t.id === chat.id)).toBe(
      !['empty', 'away-before', 'away-during', 'closed-during'].includes(scenario)
    )
    if (terminal) {
      const order = state.groupsByWorktree['wt-1']?.find((g) => g.id === groupId)?.tabOrder
      expect(order).toEqual(
        scenario === 'published-during'
          ? [chat.id, sibling.id, terminal.id]
          : scenario === 'closed-during'
            ? [sibling.id, terminal.id]
            : ['empty', 'away-before', 'away-during'].includes(scenario)
              ? [terminal.id, sibling.id]
              : [chat.id, terminal.id, sibling.id]
      )
      expect(mocks.toast).toHaveBeenCalledOnce()
      expect(state.getTab(terminal.id)?.isPinned ?? false).toBe(pinnedSource)
      expect(state.tabsByWorktree['wt-1'][0].isPinned ?? false).toBe(pinnedSource)
      if (pinnedSource) {
        const replaced = scenario === 'empty'
        expect(state.getTab(terminal.id)).toMatchObject({
          customLabel: replaced ? 'My work' : null,
          color: replaced ? '#ff0000' : null
        })
        expect(state.tabsByWorktree['wt-1'][0]).toMatchObject({
          customTitle: replaced ? 'My work' : null,
          color: replaced ? '#ff0000' : null
        })
        expect(state.getTab(chat.id)?.customLabel ?? null).toBe(replaced ? null : 'My work')
        expect(state.getTab(chat.id)?.color ?? null).toBe(replaced ? null : '#ff0000')
        expect(state.activeGroupIdByWorktree['wt-1']).toBe(groupId)
        expect(state.groupsByWorktree['wt-1'].find((g) => g.id === groupId)?.activeTabId).toBe(
          replaced ? terminal.id : chat.id
        )
        expect(state.activeTabType).toBe(replaced ? 'terminal' : 'agent-session')
      }
    }
    expect(view.result.current[0]?.text ?? '').not.toMatch(/open the agent|open it in/i)
    if (scenario === 'unreconciled') {
      expect(getStructuredAgentSessionLaunchFailure('wt-1', chat.entityId)).not.toBe(priorFailure)
      const notice = view.result.current[0]?.text
      expect(notice).toContain("couldn't show it here when the launch finished")
      act(() => {
        useAppStore.getState().createUnifiedTab('wt-1', 'terminal', {
          id: 'missing',
          activate: false
        })
      })
      expect(useAppStore.getState().getTab(chat.id)).not.toBeNull()
      expect(fallback).toHaveBeenCalledOnce()
      expect(mocks.launch).toHaveBeenCalledOnce()
      expect(view.result.current[0]?.text).toBe(notice)
      expect(mocks.toast).not.toHaveBeenCalled()
    }
    if (scenario.startsWith('away-')) {
      expect(state.activeWorktreeId).toBe('wt-2')
      expect(state.activeTabType).toBe('agent-session')
      expect(state.getActiveTab('wt-2')).toEqual(selected)
    }
    view.unmount()
  })

  // Hidden launch slots exist only in window order; count terminal position among tabs both window and main draw.
  it("places a declined chat's terminal right after the chat past a hidden launch slot", async () => {
    const { launch, chat, fallback, complete } = openChat(undefined, undefined, '')
    await main.settle()
    refuse()
    await vi.waitFor(() => expect(fallback).toHaveBeenCalled())
    const chatGroupId = groupOf(chat.id)
    const state = useAppStore.getState()
    const sibling = state.createUnifiedTab('wt-1', 'terminal', {
      entityId: 'sibling',
      targetGroupId: chatGroupId,
      activate: false
    })
    const terminal = state.createUnifiedTab('wt-1', 'terminal', {
      id: 'replacement',
      targetGroupId: chatGroupId,
      activate: false
    })
    useAppStore.setState({
      tabsByWorktree: {
        'wt-1': ORCA_LAYOUT_OWNER_IS_MAIN
          ? [terminalRecord(sibling.entityId), terminalRecord(terminal.entityId)]
          : []
      }
    })
    await mainLoadsStoreLayout()
    const slot = structuredAgentSessionTabId('hidden-launch')
    useAppStore.getState().ensureWorktreeRootGroup('wt-1', {
      tabId: slot,
      targetGroupId: chatGroupId,
      precedingTabIds: []
    })
    const order = () =>
      useAppStore.getState().groupsByWorktree['wt-1']?.find((g) => g.id === chatGroupId)?.tabOrder
    expect(order()).toEqual([slot, chat.id, sibling.id, terminal.id])

    await act(async () => {
      complete({ outcome: { status: 'created' }, tabId: terminal.id })
      await launch?.settlement
      await main.settle()
    })

    expect(useAppStore.getState().getTab(chat.id)).toBeNull()
    expect(order()?.filter((id) => id !== slot)).toEqual([terminal.id, sibling.id])
  })
})

afterEach(() => vi.useRealTimers())
it.each(['expiry', 'purge'])('created pane publication: %s', async (order) => {
  const store = () => useAppStore.getState()
  const source = store().createUnifiedTab('wt-1', 'agent-session', { entityId: 'b' })
  const groupId = store().createEmptySplitGroup('wt-1', source.groupId, 'right')!
  const chat = store().createUnifiedTab('wt-1', 'agent-session', {
    entityId: 'created',
    targetGroupId: groupId
  })
  const list = (snapshotVersion: number) =>
    applyStructuredSessionTabSnapshots([
      {
        ...makeEmptyHostSnapshot('wt-1'),
        publicationEpoch: chat.entityId,
        snapshotVersion,
        tabs: ['b'].map((sessionId) => ({
          type: 'agent-session',
          id: `agent-session:${sessionId}`,
          sessionId,
          agent: 'claude',
          title: 'Chat',
          isActive: false
        }))
      }
    ])
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  unlisted.recordUnlistedCreatedChat('wt-1', chat.entityId, 'local')
  list(100)
  expect(store().unifiedTabsByWorktree['wt-1']?.find((t) => t.id === chat.id)).toMatchObject({
    groupId
  })
  if (order === 'purge') {
    useAppStore.setState(buildFullWorktreePurgeState(store(), [{ id: 'wt-1' }]))
  }
  await vi.advanceTimersByTimeAsync(30_000)
  expect(unlisted.isUnlistedCreatedChat('wt-1', chat.entityId)).toBe(false)
  if (order === 'purge') {
    expect(store().unifiedTabsByWorktree['wt-1']).toBeUndefined()
  } else {
    expect(store().unifiedTabsByWorktree['wt-1']?.some((t) => t.id === chat.id)).toBe(true)
    list(101)
    expect(store().unifiedTabsByWorktree['wt-1']?.some((t) => t.id === chat.id)).toBe(
      ORCA_LAYOUT_OWNER_IS_MAIN
    )
  }
})
