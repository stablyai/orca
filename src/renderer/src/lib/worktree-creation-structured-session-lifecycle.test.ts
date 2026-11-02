// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from './worktree-activation-created-agent.test-fixture'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import type { StructuredLaunchAdmission } from './agent-session/launch/structured-agent-session-host-admission'
import type * as admissionModule from './agent-session/launch/structured-agent-session-host-admission'
import type * as launchModule from './agent-session/launch/structured-agent-session-launch-create-call'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from './agent-session/launch/structured-agent-session-launch-registry'
import { StructuredAgentSessionCreateRefusalError } from './agent-session/launch/structured-agent-session-launch-errors'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import {
  clearNativeChatComposerDraftsForTests,
  hydrateNativeChatComposerDrafts,
  flushNativeChatComposerDrafts,
  isNativeChatComposerDraftUnsaved,
  nativeChatComposerDraftWritesSettled,
  readNativeChatComposerDraft,
  structuredAgentSessionDraftScopeKey,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'
import {
  createMemoryNativeChatComposerDraftStorage,
  setNativeChatComposerDraftStorageForTests
} from '@/components/native-chat/native-chat-composer-draft-storage'
import { pendingCreationChatDraftScopeKey } from './pending-worktree-creation'
import { hasStagedStructuredLaunchPrompt } from './agent-session/launch/structured-agent-session-launch-prompt'

const mocks = vi.hoisted(() => ({
  admission: vi.fn<typeof admissionModule.admitStructuredLaunchOnHost>(),
  createSession: vi.fn<typeof launchModule.launchStructuredAgentSession>()
}))
vi.mock('./agent-session/launch/structured-agent-session-host-admission', async (original) => ({
  ...(await original<typeof admissionModule>()),
  admitStructuredLaunchOnHost: mocks.admission
}))
vi.mock('./agent-session/launch/structured-agent-session-launch-create-call', async (original) => ({
  ...(await original<typeof launchModule>()),
  launchStructuredAgentSession: mocks.createSession
}))
vi.mock('@/runtime/runtime-rpc-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/components/native-chat/native-chat-composer-mount', () => ({
  nativeChatComposerSelection: () => undefined,
  waitForNativeChatComposerHandoff: async () => {}
}))

const initialState = useAppStore.getState()
const worktree = makeCreatedAgentWorktree()
const request: WorktreeCreationRequest = {
  repoId: worktree.repoId,
  name: 'feature',
  setupDecision: 'skip',
  agent: 'codex',
  agentLaunchRoute: 'structured-native-chat',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: 'Fix the flaky test',
  quickTelemetry: null
}
let main: TabsDrawnFromMain

beforeEach(async () => {
  vi.clearAllMocks()
  resetStructuredAgentLaunchRegistryForTests()
  seedEmptyActivatableWorktree(worktree)
  useAppStore.setState({
    activeWorktreeId: 'previous-worktree',
    activePendingCreationId: 'creation-1',
    pendingWorktreeCreations: {
      'creation-1': {
        creationId: 'creation-1',
        phase: 'creating',
        status: 'creating',
        startedAt: 1,
        indeterminate: false,
        loaderVisible: true,
        request
      }
    },
    createWorktree: vi.fn().mockResolvedValue({ worktree })
  })
  mocks.admission.mockResolvedValue({ kind: 'admitted' })
  mocks.createSession.mockReturnValue(new Promise(() => {}))
  main = await drawTabsFromMain(useAppStore)
})

afterEach(() => {
  main.close()
  clearNativeChatComposerDraftsForTests()
  vi.restoreAllMocks()
  resetStructuredAgentLaunchRegistryForTests()
  useAppStore.setState(initialState, true)
})

describe('creation chat handoff', () => {
  it.each(['slow', 'refused', 'background'] as const)(
    'hands the live draft to the published chat independently of persistence: %s',
    async (scenario) => {
      const storage = createMemoryNativeChatComposerDraftStorage()
      setNativeChatComposerDraftStorageForTests(storage)
      await hydrateNativeChatComposerDrafts()
      const source = pendingCreationChatDraftScopeKey('creation-1')
      updateNativeChatComposerDraft(source, { text: 'Unsent follow-up' }, 'immediate')
      await nativeChatComposerDraftWritesSettled()
      const committed = Promise.withResolvers<void>()
      const started = Promise.withResolvers<string>()
      const write = storage.write
      storage.write = async (scope, draft) => {
        if (scope.startsWith('agent-session:')) {
          started.resolve(scope)
          await committed.promise
        }
        await write(scope, draft)
      }
      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('refused', 'QuotaExceededError')
      })
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (scenario === 'background') {
        useAppStore.setState({ activeView: 'tasks' })
      }

      const completion = executeWorktreeCreation('creation-1', request)
      const destination = await started.promise
      await completion

      const state = useAppStore.getState()
      expect(state.pendingWorktreeCreations['creation-1']).toBeUndefined()
      expect(state.activePendingCreationId).toBeNull()
      expect(state.activeWorktreeId).toBe(
        scenario === 'background' ? 'previous-worktree' : worktree.id
      )
      expect(state.activeView).toBe(scenario === 'background' ? 'tasks' : 'terminal')
      expect(state.getActiveTab(worktree.id)).toMatchObject({
        contentType: 'agent-session',
        entityId: destination.slice('agent-session:'.length)
      })
      expect(readNativeChatComposerDraft(source).text).toBe('')
      expect(readNativeChatComposerDraft(destination).text).toBe('Unsent follow-up')
      expect(storage.drafts.get(source)?.text).toBe('Unsent follow-up')
      expect(storage.drafts.has(destination)).toBe(false)

      const latest = 'Unsent follow-up with newer typing in the replacement'
      updateNativeChatComposerDraft(destination, { text: latest }, 'immediate')
      storage.refuseWrites = scenario === 'refused'
      committed.resolve()
      await nativeChatComposerDraftWritesSettled()
      expect(readNativeChatComposerDraft(destination).text).toBe(latest)
      if (scenario === 'refused') {
        expect(isNativeChatComposerDraftUnsaved(destination)).toBe(true)
        expect(storage.drafts.get(source)?.text).toBe('Unsent follow-up')
        storage.refuseWrites = false
        flushNativeChatComposerDrafts()
        await nativeChatComposerDraftWritesSettled()
      }
      expect(storage.drafts.get(destination)?.text).toBe(latest)
      expect(storage.drafts.has(source)).toBe(false)
      expect(state.createWorktree).toHaveBeenCalledOnce()
      expect(mocks.createSession).toHaveBeenCalledOnce()
    }
  )

  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
    'owns input through delayed host admission and replacement tab publication',
    async () => {
      const emptyRequest = { ...request, quickPrompt: '' }
      useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
        request: emptyRequest,
        heldChatMessage: 'First message accepted before launch'
      })
      const scope = pendingCreationChatDraftScopeKey('creation-1')
      updateNativeChatComposerDraft(scope, { text: 'Unsent follow-up', images: [] }, 'immediate')
      const admission = Promise.withResolvers<StructuredLaunchAdmission>()
      mocks.admission.mockImplementation(() => {
        expect(
          useAppStore.getState().pendingWorktreeCreations['creation-1']?.chatInputHandedOff
        ).toBe(true)
        return admission.promise
      })
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab' ? 'pending' : 'apply'
      )

      const completion = executeWorktreeCreation('creation-1', emptyRequest)
      await vi.waitFor(() => expect(mocks.admission).toHaveBeenCalled())
      expect(readNativeChatComposerDraft(scope).text).toBe('Unsent follow-up')

      admission.resolve({ kind: 'admitted' })
      await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
      const intent = mocks.createSession.mock.calls[0][0]
      expect(hasStagedStructuredLaunchPrompt(intent.sessionId)).toBe(true)
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(intent.sessionId)).text
      ).toBe('')
      expect(readNativeChatComposerDraft(scope).text).toBe('Unsent follow-up')
      expect(useAppStore.getState().activePendingCreationId).toBe('creation-1')
      expect(
        useAppStore.getState().pendingWorktreeCreations['creation-1']?.chatInputHandedOff
      ).toBe(true)

      layoutApplyTestTransport.answerWith('apply')
      layoutApplyTestTransport.answerPending()
      await completion
      expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(intent.sessionId)).text
      ).toBe('Unsent follow-up')
    }
  )

  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
    'waits for the answering layout frame even when provider creation fails first',
    async () => {
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab' ? 'pending' : 'apply'
      )
      mocks.createSession.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('no'))

      const completion = executeWorktreeCreation('creation-1', request)
      await vi.waitFor(() => expect(layoutApplyTestTransport.pendingCount).toBe(1))
      await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalled())
      const intent = mocks.createSession.mock.calls[0][0]
      await vi.waitFor(() =>
        expect(getStructuredLaunchStateBySessionId(intent.sessionId)?.callers.outcome).toBe(
          'failed'
        )
      )
      expect(useAppStore.getState().activeWorktreeId).toBe('previous-worktree')
      expect(useAppStore.getState().activePendingCreationId).toBe('creation-1')

      layoutApplyTestTransport.answerWith('apply')
      layoutApplyTestTransport.answerPending()
      await completion
      expect(useAppStore.getState().activeWorktreeId).toBe(worktree.id)
      expect(useAppStore.getState().getActiveTab(worktree.id)?.contentType).toBe('agent-session')
      expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
    }
  )

  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN)(
    'preserves the held first message in a terminal when layout refuses the chat',
    async () => {
      const emptyRequest = { ...request, quickPrompt: '' }
      useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
        request: emptyRequest,
        heldChatMessage: 'Recover this first message'
      })
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab'
          ? { ok: false, code: 'pane_structure_changed' }
          : 'apply'
      )

      await executeWorktreeCreation('creation-1', emptyRequest)
      await main.settle()

      const state = useAppStore.getState()
      expect(state.pendingWorktreeCreations['creation-1']).toBeUndefined()
      expect(state.tabsByWorktree[worktree.id]).toHaveLength(1)
      expect(state.getActiveTab(worktree.id)?.contentType).toBe('terminal')
      const tabId = state.tabsByWorktree[worktree.id]![0]!.id
      expect(state.pendingStartupByTabId[tabId]).toMatchObject({
        command: expect.stringContaining('Recover this first message')
      })
    }
  )

  it('finishes creation when the host opens a terminal instead of a chat', async () => {
    mocks.admission.mockResolvedValue({ kind: 'declined' })

    await executeWorktreeCreation('creation-1', request)
    await main.settle()

    const state = useAppStore.getState()
    expect(state.activeWorktreeId).toBe(worktree.id)
    expect(state.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(state.getActiveTab(worktree.id)?.contentType).toBe('terminal')
    expect(state.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(mocks.createSession).not.toHaveBeenCalled()
  })

  it('dismisses a pending admission without opening a late chat', async () => {
    const admission = Promise.withResolvers<StructuredLaunchAdmission>()
    mocks.admission.mockReturnValue(admission.promise)

    const completion = executeWorktreeCreation('creation-1', request)
    await vi.waitFor(() => expect(mocks.admission).toHaveBeenCalled())
    useAppStore.getState().removePendingWorktreeCreation('creation-1')
    await completion

    admission.resolve({ kind: 'admitted' })
    await main.settle()
    expect(useAppStore.getState().activeWorktreeId).toBe('previous-worktree')
    expect(useAppStore.getState().unifiedTabsByWorktree[worktree.id] ?? []).toEqual([])
    expect(mocks.createSession).not.toHaveBeenCalled()
  })
})
