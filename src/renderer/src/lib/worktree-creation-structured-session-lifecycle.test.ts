// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import { retryBackgroundWorktreeCreation } from './worktree-creation-flow'
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
import { getStructuredAgentSessionPendingSends } from '@/components/native-chat/structured-agent-session-pending-sends'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/structured-agent-session-message-sender'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot,
  settleNativeChatPendingAttachment
} from '@/components/native-chat/native-chat-pending-attachment-cache'
import { holdBrowserAttachmentFiles, readBrowserAttachmentFile } from './browser-attachment-files'
import {
  holdNativeChatStagedInput,
  releaseNativeChatStagedFiles,
  stageNativeChatDraftFile
} from '@/components/native-chat/native-chat-draft-attachment-staging'

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
  resetStructuredAgentSessionSendsForTests()
  releaseNativeChatStagedFiles(pendingCreationChatDraftScopeKey('creation-1'))
  for (const tab of Object.values(useAppStore.getState().unifiedTabsByWorktree).flat()) {
    if (tab.contentType === 'agent-session') {
      releaseNativeChatStagedFiles(structuredAgentSessionDraftScopeKey(tab.entityId))
    }
  }
  clearNativeChatPendingAttachmentsForTests()
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
    'owns input through delayed provider creation and replacement tab publication',
    async () => {
      const emptyRequest = { ...request, quickPrompt: '' }
      useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
        request: emptyRequest,
        heldChatMessage: 'First message accepted before launch'
      })
      const scope = pendingCreationChatDraftScopeKey('creation-1')
      updateNativeChatComposerDraft(scope, { text: 'Unsent follow-up', images: [] }, 'immediate')
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab' ? 'pending' : 'apply'
      )

      const completion = executeWorktreeCreation('creation-1', emptyRequest)
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

  it.skipIf(!ORCA_LAYOUT_OWNER_IS_MAIN).each(['foreground', 'background'] as const)(
    'retries a layout-refused rich message in the created worktree without creating it again: %s',
    async (scenario) => {
      const emptyRequest = { ...request, quickPrompt: '' }
      const attachment = { id: 'held-image', path: '/tmp/held-image.png' }
      const skill = { name: 'test-audit', path: '/repo/.agents/skills/test-audit/SKILL.md' }
      const message = 'Use $test-audit to review this image'
      const source = pendingCreationChatDraftScopeKey('creation-1')
      useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
        request: emptyRequest,
        heldChatMessage: message,
        heldChatAttachments: [attachment],
        heldChatSkills: [skill]
      })
      updateNativeChatComposerDraft(source, { text: 'Unsent follow-up' }, 'immediate')
      if (scenario === 'background') {
        useAppStore.setState({ activeView: 'tasks' })
      }
      layoutApplyTestTransport.answerWith((command) =>
        command.type === 'openAgentSessionTab'
          ? { ok: false, code: 'pane_structure_changed' }
          : 'apply'
      )

      await executeWorktreeCreation('creation-1', emptyRequest)
      await main.settle()

      const refused = useAppStore.getState()
      expect(refused.pendingWorktreeCreations['creation-1']).toMatchObject({
        status: 'error',
        worktreeId: worktree.id,
        error: expect.any(String),
        heldChatMessage: message,
        heldChatAttachments: [attachment],
        heldChatSkills: [skill]
      })
      expect(refused.activePendingCreationId).toBe('creation-1')
      expect(refused.tabsByWorktree[worktree.id] ?? []).toEqual([])
      expect(readNativeChatComposerDraft(source).text).toBe('Unsent follow-up')
      expect(refused.createWorktree).toHaveBeenCalledOnce()

      layoutApplyTestTransport.answerWith('apply')
      useAppStore.setState({ activeView: 'terminal' })
      retryBackgroundWorktreeCreation('creation-1')
      await vi.waitFor(() =>
        expect(useAppStore.getState().pendingWorktreeCreations['creation-1']).toBeUndefined()
      )
      await main.settle()

      const retried = useAppStore.getState()
      const tab = retried.getActiveTab(worktree.id)
      expect(tab).toMatchObject({ contentType: 'agent-session', worktreeId: worktree.id })
      if (!tab) {
        throw new Error('Retry did not open a chat')
      }
      expect(retried.createWorktree).toHaveBeenCalledOnce()
      expect(retried.activeWorktreeId).toBe(worktree.id)
      expect(retried.activePendingCreationId).toBeNull()
      expect(readNativeChatComposerDraft(source).text).toBe('')
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId)).text
      ).toBe('Unsent follow-up')
      expect(getStructuredAgentSessionPendingSends(tab.entityId)).toMatchObject([
        {
          body: {
            blocks: [
              { type: 'text', text: message },
              { type: 'image-ref', path: attachment.path }
            ],
            skills: [skill]
          }
        }
      ])
    }
  )

  it('keeps a rich first message and unsent follow-up in the failed chat when its host declines', async () => {
    const emptyRequest = { ...request, quickPrompt: '' }
    const source = pendingCreationChatDraftScopeKey('creation-1')
    const file = new File(['image'], 'held.png', { type: 'image/png' })
    const [path] = holdBrowserAttachmentFiles([file])
    const heldAttachment = { id: 'held-image', path }
    stageNativeChatDraftFile(source, path)
    holdNativeChatStagedInput(source, {
      text: 'Review this image',
      attachments: [heldAttachment]
    })
    useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
      request: emptyRequest,
      heldChatMessage: 'Review this image',
      heldChatAttachments: [heldAttachment]
    })
    updateNativeChatComposerDraft(
      source,
      {
        text: 'Unsent follow-up',
        images: [{ id: 'follow-up-image', path: '/tmp/follow-up.png' }]
      },
      'immediate'
    )
    mocks.createSession.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('no'))

    await executeWorktreeCreation('creation-1', emptyRequest)
    await main.settle()

    const state = useAppStore.getState()
    const tab = state.getActiveTab(worktree.id)
    expect(tab).toMatchObject({ contentType: 'agent-session' })
    if (!tab) {
      throw new Error('The declined chat was discarded')
    }
    await vi.waitFor(() =>
      expect(getStructuredLaunchStateBySessionId(tab.entityId)?.callers.outcome).toBe('failed')
    )
    await vi.waitFor(() =>
      expect(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId)).images
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path }),
          expect.objectContaining({ path: '/tmp/follow-up.png' })
        ])
      )
    )
    expect(state.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(state.tabsByWorktree[worktree.id] ?? []).toEqual([])
    expect(readNativeChatComposerDraft(source).text).toBe('')
    const destination = structuredAgentSessionDraftScopeKey(tab.entityId)
    const draft = readNativeChatComposerDraft(destination)
    expect(draft.text).toContain('Review this image')
    expect(draft.text).toContain('Unsent follow-up')
    expect(readBrowserAttachmentFile(path)).toBe(file)
    updateNativeChatComposerDraft(
      destination,
      { images: draft.images.filter((image) => image.path !== path) },
      'immediate'
    )
    await vi.waitFor(() => expect(readBrowserAttachmentFile(path)).toBeNull())
  })

  it('keeps an image still saving in the failed chat when its host declines before any send', async () => {
    const emptyRequest = { ...request, quickPrompt: '' }
    const source = pendingCreationChatDraftScopeKey('creation-1')
    useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
      request: emptyRequest
    })
    addNativeChatPendingAttachment(source, {
      id: 'saving-image',
      path: '',
      pending: true
    })
    mocks.admission.mockResolvedValue({ kind: 'declined' })
    mocks.createSession.mockRejectedValue(new StructuredAgentSessionCreateRefusalError('no'))

    await executeWorktreeCreation('creation-1', emptyRequest)
    await main.settle()

    const state = useAppStore.getState()
    const tab = state.getActiveTab(worktree.id)
    expect(tab).toMatchObject({ contentType: 'agent-session' })
    if (!tab) {
      throw new Error('The pending image lost its chat')
    }
    await vi.waitFor(() =>
      expect(getStructuredLaunchStateBySessionId(tab.entityId)?.callers.outcome).toBe('failed')
    )
    const destination = structuredAgentSessionDraftScopeKey(tab.entityId)
    expect(state.pendingWorktreeCreations['creation-1']).toBeUndefined()
    expect(state.tabsByWorktree[worktree.id] ?? []).toEqual([])
    expect(nativeChatPendingAttachmentSnapshot(destination)).toMatchObject([
      { id: 'saving-image', pending: true }
    ])
    expect(settleNativeChatPendingAttachment(source, 'saving-image', '/tmp/saved.png')).toBe(true)
    expect(readNativeChatComposerDraft(destination).images).toEqual([
      { id: 'saving-image', path: '/tmp/saved.png' }
    ])
    expect(readNativeChatComposerDraft(source).images).toEqual([])
  })

  it('keeps rich input in the pending composer when the created worktree has no resolved host', async () => {
    const source = pendingCreationChatDraftScopeKey('creation-1')
    const attachment = { id: 'held-image', path: '/tmp/held.png' }
    const state = useAppStore.getState()
    const repo = state.repos[0]!
    useAppStore.setState({
      repos: [
        { ...repo, executionHostId: 'local' },
        { ...repo, connectionId: 'box', executionHostId: 'ssh:box' }
      ],
      worktreesByRepo: {
        [worktree.repoId]: [
          { ...worktree, hostId: 'local' },
          { ...worktree, hostId: 'ssh:box' }
        ]
      },
      activeWorkspaceExecutionHostId: null
    })
    useAppStore.getState().updatePendingWorktreeCreation('creation-1', {
      heldChatMessage: 'Review this image',
      heldChatAttachments: [attachment]
    })
    updateNativeChatComposerDraft(source, { text: 'Unsent follow-up' }, 'immediate')

    await executeWorktreeCreation('creation-1', request)
    await main.settle()

    const retained = useAppStore.getState()
    expect(retained.pendingWorktreeCreations['creation-1']).toMatchObject({
      status: 'error',
      worktreeId: worktree.id,
      heldChatMessage: 'Review this image',
      heldChatAttachments: [attachment]
    })
    expect(retained.activePendingCreationId).toBe('creation-1')
    expect(retained.unifiedTabsByWorktree[worktree.id] ?? []).toEqual([])
    expect(readNativeChatComposerDraft(source).text).toBe('Unsent follow-up')
    expect(mocks.createSession).not.toHaveBeenCalled()
    expect(retained.createWorktree).toHaveBeenCalledOnce()
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
