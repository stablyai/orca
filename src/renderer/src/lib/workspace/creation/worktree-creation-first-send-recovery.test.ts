// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from 'vitest'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'
import type { ProvisionalLaunchArgs } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import type { StructuredPromptDeliveryResult } from '@/lib/agent-session/launch/structured-agent-session-launch-callers'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'

const boundary = vi.hoisted(() => ({
  delivery: Promise.resolve<StructuredPromptDeliveryResult>({
    delivered: false,
    failureNotified: true
  }),
  open: true
}))
vi.mock('@/store/index', async () => {
  const { create } = await import('zustand')
  const pending: Record<string, PendingWorktreeCreation> = {}
  const tabs: Record<string, Tab> = {}
  const useAppStore = create(() => ({
    pendingWorktreeCreations: pending,
    activeView: 'terminal',
    activePendingCreationId: 'creation',
    getTab: (id: string) => tabs[id],
    updatePendingWorktreeCreation: (id: string, patch: Partial<PendingWorktreeCreation>) => {
      useAppStore.setState((state) => ({
        pendingWorktreeCreations: {
          ...state.pendingWorktreeCreations,
          [id]: { ...state.pendingWorktreeCreations[id], ...patch }
        }
      }))
    },
    tabs
  }))
  return { useAppStore }
})
vi.mock('@/components/native-chat/composer/focus/use-native-chat-composer-reveal-focus', () => ({}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-surface', () => ({
  findStructuredLaunchTab: () => undefined
}))
vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-registry', () => ({
  getStructuredAgentSessionLaunchOwner: () => 'local'
}))
vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: (args: ProvisionalLaunchArgs) => {
    args.onTabOpenSettled?.(boundary.open ? 'created-tab' : null)
    return {
      tab: { tabId: 'created-tab' },
      promptDeliveryResult: boundary.delivery,
      settlement: Promise.resolve({ kind: 'chat' }),
      cancel: () => {}
    }
  }
}))

const { launchStructuredWorktreeSession } = await import('./worktree-creation-structured-session')
const { useAppStore } = await import('@/store/index')
const { readNativeChatComposerDraft, updateNativeChatComposerDraft } =
  await import('@/components/native-chat/drafts/native-chat-composer-draft-store')
const { captureNativeChatStagedInput } =
  await import('@/components/native-chat/drafts/native-chat-staged-input')
const {
  stagedNativeChatFiles,
  stageNativeChatDraftFile,
  holdNativeChatStagedInput,
  reconcileNativeChatStagedDraft
} = await import('@/components/native-chat/drafts/native-chat-draft-attachment-staging')
const { pendingCreationChatDraftScopeKey } = await import('./pending-worktree-creation')
const scope = pendingCreationChatDraftScopeKey('creation')
const request: WorktreeCreationRequest = {
  repoId: 'repo',
  name: 'test',
  setupDecision: 'skip',
  agent: 'codex',
  agentLaunchRoute: 'structured-native-chat',
  pendingFirstAgentMessageRename: false,
  note: '',
  startupPlan: null,
  quickPrompt: '',
  quickTelemetry: null
}
const images = [
  { id: 'a', path: 'blob:first-a' },
  { id: 'b', path: 'blob:first-b' }
]
const first = 'exact opening [Image #1] then [Image #2]'
const tabs: Record<string, Tab> = {
  'created-tab': {
    id: 'created-tab',
    entityId: 'created',
    worktreeId: 'wt',
    executionHostId: 'local',
    contentType: 'agent-session',
    groupId: 'g',
    label: 'Created',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

beforeEach(() => {
  boundary.open = true
  const state = useAppStore.getState()
  Object.assign(state, { tabs })
  // The host/layout boundary publishes the destination; the real caller moves the remaining draft.
  state.getTab = (id: string) => tabs[id]
  state.updatePendingWorktreeCreation('creation', {
    creationId: 'creation',
    phase: 'creating',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request,
    heldChatMessage: first,
    heldChatAttachments: images
  })
  for (const { path } of images) {
    stageNativeChatDraftFile(scope, path)
  }
  holdNativeChatStagedInput(scope, { text: first, attachments: images })
  reconcileNativeChatStagedDraft(scope, { text: '', images: [] })
})

it.each(['', 'later typing'])(
  'keeps the sole first-message recovery row after a pre-install loss with remaining draft %j',
  async (remaining) => {
    const result = Promise.withResolvers<StructuredPromptDeliveryResult>()
    boundary.delivery = result.promise
    updateNativeChatComposerDraft(scope, { text: remaining, images: [] }, 'immediate')
    let completed = false
    const launched = launchStructuredWorktreeSession({
      creationId: 'creation',
      request,
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'wt',
      shouldActivateOnCompletion: false,
      activation: false,
      primaryTabId: null
    }).then((outcome) => {
      completed = true
      return outcome
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(completed).toBe(false)
    result.resolve({ delivered: false, failureNotified: true })
    expect((await launched).retainedInput).toBe(true)
    const pending = useAppStore.getState().pendingWorktreeCreations.creation
    expect(pending.heldChatMessage).toBe(first)
    expect(pending.heldChatAttachments).toEqual(images)
    expect(readNativeChatComposerDraft('agent-session:created').text).toBe(remaining)
    expect(stagedNativeChatFiles(scope)?.leases.size).toBe(0)
    const retry = captureNativeChatStagedInput(scope, { text: first, attachments: images })
    expect(
      (
        await retry.prepare(
          { text: first, attachments: images },
          { sessionId: 'retry', runtimeEnvironmentId: null }
        )
      ).attachments
    ).toEqual(images)
    retry.release()
  }
)

it.each([
  { delivered: true, failureNotified: false },
  { delivered: false, failureNotified: true, inComposer: true, handBackFinished: true },
  { delivered: false, failureNotified: true, handBackFinished: true }
] as const)('allows completion only after delivery or usable hand-back: %j', async (result) => {
  boundary.delivery = Promise.resolve(result)
  const outcome = await launchStructuredWorktreeSession({
    creationId: 'creation',
    request,
    agentLaunchRoute: 'structured-native-chat',
    worktreeId: 'wt',
    shouldActivateOnCompletion: false,
    activation: false,
    primaryTabId: null
  })
  expect(outcome.retainedInput).toBeUndefined()
})

it('retires the Retry hold after an exact late record and never repeats that first message', async () => {
  const { worktreeCreationFirstSend } = await import('./worktree-creation-first-send')
  const recorded = Promise.withResolvers<void>()
  boundary.delivery = Promise.resolve({
    delivered: false,
    failureNotified: false,
    unconfirmed: true,
    whenRecorded: recorded.promise
  })
  const outcome = await launchStructuredWorktreeSession({
    creationId: 'creation',
    request,
    agentLaunchRoute: 'structured-native-chat',
    worktreeId: 'wt',
    shouldActivateOnCompletion: false,
    activation: false,
    primaryTabId: null
  })
  expect(outcome.retainedInput).toBe(true)
  expect(stagedNativeChatFiles(scope)?.leases.size).toBe(0)
  recorded.resolve()
  await recorded.promise
  await Promise.resolve()
  const pending = useAppStore.getState().pendingWorktreeCreations.creation
  expect(pending.heldChatMessage).toBe(first)
  expect(worktreeCreationFirstSend(request, pending)).toEqual({ text: '' })
  expect(stagedNativeChatFiles(scope)).toBeUndefined()
})
