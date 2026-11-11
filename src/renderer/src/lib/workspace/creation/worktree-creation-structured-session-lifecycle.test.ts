// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import 'sonner'
import { executeWorktreeCreation } from './worktree-creation-flow-execute'
import './worktree-creation-flow'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from '../activation/worktree-activation-created-agent.test-fixture'
import type * as admissionModule from '../../agent-session/launch/structured-agent-session-host-admission'
import type * as launchModule from '../../agent-session/launch/structured-agent-session-launch-create-call'
import {
  getStructuredLaunchStateBySessionId,
  resetStructuredAgentLaunchRegistryForTests
} from '../../agent-session/launch/structured-agent-session-launch-registry'
import { StructuredAgentSessionCreateRefusalError } from '../../agent-session/launch/structured-agent-session-launch-errors'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs/tabs-drawn-from-main.test-fixture'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '@/components/native-chat/drafts/native-chat-draft-scope'
import '@/components/native-chat/drafts/native-chat-composer-draft-load'
import '@/components/native-chat/drafts/native-chat-composer-draft-persistence'
import '@/components/native-chat/drafts/native-chat-composer-draft-storage'
import {
  type WorktreeCreationRequest,
  pendingCreationChatDraftScopeKey
} from './pending-worktree-creation'
import '../../agent-session/launch/structured-agent-session-launch-prompt'
import '@/components/native-chat/session/structured/delivery/structured-agent-session-pending-sends'
import { resetStructuredAgentSessionSendsForTests } from '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachmentsForTests,
  nativeChatPendingAttachmentSnapshot,
  settleNativeChatPendingAttachment
} from '@/components/native-chat/attachments/chips/native-chat-pending-attachment-cache'
import {
  holdBrowserAttachmentFiles,
  readBrowserAttachmentFile
} from '../../files/drop/browser-attachment-files'
import {
  holdNativeChatStagedInput,
  releaseNativeChatStagedFiles,
  stageNativeChatDraftFile
} from '@/components/native-chat/drafts/native-chat-draft-attachment-staging'

const mocks = vi.hoisted(() => ({
  admission: vi.fn<typeof admissionModule.admitStructuredLaunchOnHost>(),
  createSession: vi.fn<typeof launchModule.launchStructuredAgentSession>()
}))
vi.mock('../../agent-session/launch/structured-agent-session-host-admission', async (original) => ({
  ...(await original<typeof admissionModule>()),
  admitStructuredLaunchOnHost: mocks.admission
}))
vi.mock(
  '../../agent-session/launch/structured-agent-session-launch-create-call',
  async (original) => ({
    ...(await original<typeof launchModule>()),
    launchStructuredAgentSession: mocks.createSession
  })
)
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await original())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (original) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await original())
)
vi.mock('@/components/native-chat/composer/focus/native-chat-composer-mount', () => ({
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
})
