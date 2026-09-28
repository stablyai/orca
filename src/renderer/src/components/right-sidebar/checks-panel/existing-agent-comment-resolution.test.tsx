// @vitest-environment happy-dom

import path from 'node:path'
import React, { type ReactNode, useRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { PRCommentGroup } from '../../../../../shared/pr-comment-groups'
import type { PendingPRCommentAiAck } from '../pr-comments-ai-launch-ack'
import type { ChecksAgentComposerState } from './panel-state-types'
import type { ChecksPanelActiveContentModel } from './active-content-props'

type NoteTarget = {
  paneKey: string
  tabId: string
  leafId: string
  agentType: 'claude'
  tabTitle: string
  status: 'eligible' | 'disabled'
  disabledReason?: string
}

const mocks = vi.hoisted(() => {
  const noteTargets: NoteTarget[] = []
  return {
    sendNotesToActiveAgentSession: vi.fn(),
    launchAgentInNewTab: vi.fn(),
    resolveReviewThread: vi.fn(),
    resolveGitLabMRDiscussionForChecks: vi.fn(),
    addPRReviewCommentReply: vi.fn(),
    addPRConversationComment: vi.fn(),
    ensureDetectedAgents: vi.fn(),
    ensureRemoteDetectedAgents: vi.fn(),
    planSourceControlAgentActionLaunch: vi.fn(),
    noteTargets
  }
})

vi.mock('../HostedReviewActions', () => ({ default: () => null }))
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({ value }: { value: string | null }) =>
    React.createElement('div', { 'data-agent-value': value ?? '' })
}))
vi.mock('../../source-control/SourceControlActionVariableChips', () => ({
  SourceControlActionVariableChips: () => null
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children?: ReactNode }) =>
    open ? React.createElement('div', { role: 'dialog' }, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) =>
    React.createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => React.createElement('h2', null, children)
}))
// Why: Radix menus need pointer events happy-dom lacks; render rows inline and select on click.
vi.mock('@/components/ui/dropdown-menu', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DropdownMenu: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DropdownMenuTrigger: ({ children }: { children?: ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DropdownMenuLabel: ({ children }: { children?: ReactNode }) =>
    React.createElement('div', null, children),
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children?: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) =>
    React.createElement('button', { role: 'menuitem', disabled, onClick: () => onSelect?.() }, [
      children
    ])
}))
vi.mock('@/lib/active-agent-note-send', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
}))
vi.mock('@/lib/notes-send-agent-targets', () => ({
  deriveNotesSendAgentTargets: () => mocks.noteTargets
}))
vi.mock('@/components/sidebar/useWorktreeAgentRows', () => ({
  useWorktreeAgentRows: () => []
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: mocks.launchAgentInNewTab
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))
vi.mock('@/lib/source-control-agent-action-plan', () => ({
  planSourceControlAgentActionLaunch: mocks.planSourceControlAgentActionLaunch
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))
vi.mock('./gitlab-review-client', () => ({
  resolveGitLabMRDiscussionForChecks: mocks.resolveGitLabMRDiscussionForChecks
}))
vi.mock('sonner', () => ({
  toast: {
    dismiss: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    message: vi.fn(),
    success: vi.fn()
  }
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore, type AppState } from '@/store'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import {
  clearPendingPRCommentAiAck,
  setPendingPRCommentAiAck,
  takePendingPRCommentAiAck
} from '../pr-comments-ai-launch-ack'
import { useChecksPanelAiAcknowledgement } from './use-checks-panel-ai-acknowledgement'
import { ChecksPanelActiveContent } from './active-content'

const REVIEW_KEY = 'review-42'
const BASE_PROMPT = 'Resolve the selected PR comments.'
const ELIGIBLE_TARGET = {
  paneKey: 'tab-a:11111111-1111-4111-8111-111111111111',
  tabId: 'tab-a',
  leafId: '11111111-1111-4111-8111-111111111111',
  agentType: 'claude' as const,
  tabTitle: 'Claude session',
  status: 'eligible' as const
}

function threadGroup(threadId: string): PRCommentGroup {
  return {
    kind: 'thread',
    threadId,
    root: {
      id: 10,
      author: 'alice',
      authorAvatarUrl: '',
      body: 'Please update this.',
      createdAt: '2026-05-14T00:00:00Z',
      url: 'https://example.test/review#discussion_r1',
      threadId,
      path: 'src/a.ts',
      isResolved: false
    },
    replies: []
  }
}

function resolutionFor(provider: 'github' | 'gitlab'): PendingPRCommentAiAck {
  if (provider === 'gitlab') {
    return {
      reviewContextKey: REVIEW_KEY,
      provider,
      selectedGroups: [threadGroup('D1')],
      gitlabTarget: { repoPath: '/repo', repoId: 'repo-1', iid: 7 }
    }
  }
  return {
    reviewContextKey: REVIEW_KEY,
    provider,
    selectedGroups: [threadGroup('T1')],
    githubResolveTarget: { repoPath: '/repo', repoId: 'repo-1', prNumber: 42 }
  }
}

type HarnessHandle = { pendingRef: { current: PendingPRCommentAiAck | null } }

function Harness({
  resolution,
  connectionId,
  handle
}: {
  resolution: PendingPRCommentAiAck
  connectionId: string | null
  handle: HarnessHandle
}): React.JSX.Element {
  const pendingCommentResolutionRef = useRef<PendingPRCommentAiAck | null>(resolution)
  const claimedCommentResolutionRef = useRef<PendingPRCommentAiAck | null>(null)
  const commentResolutionLaunchAcceptedRef = useRef(false)
  handle.pendingRef = pendingCommentResolutionRef
  const [agentComposerState, setAgentComposerState] = useState<ChecksAgentComposerState | null>({
    actionId: 'resolveComments',
    title: 'Resolve Comments With AI',
    description: 'Review the prompt before starting an agent.',
    prompt: BASE_PROMPT,
    launchSource: 'task_page',
    commentResolution: resolution
  })
  const ack = useChecksPanelAiAcknowledgement({
    addPRConversationComment: mocks.addPRConversationComment,
    addPRReviewCommentReply: mocks.addPRReviewCommentReply,
    asyncResultKeyRef: { current: REVIEW_KEY },
    claimedCommentResolutionRef,
    commentsRef: { current: [] },
    commentsSelectionClearTokenRef: { current: 0 },
    pendingCommentResolutionRef,
    resolveReviewThread: mocks.resolveReviewThread,
    setCommentResolutionAckBusyNow: vi.fn(),
    setComments: vi.fn(),
    setCommentsSelectionClearRequest: vi.fn(),
    settings: null,
    commentResolutionLaunchAcceptedRef,
    fetchComments: vi.fn(async () => {}),
    fetchGitLabDetails: vi.fn(async () => {})
  })
  const model = {
    activeConnectionId: connectionId,
    activeConflictReview: null,
    activeGitLabReview: null,
    activeReview: {
      provider: resolution.provider,
      number: resolution.provider === 'gitlab' ? 7 : 42,
      state: 'open',
      title: 'Review under test',
      url: 'https://example.test/review',
      status: 'success',
      updatedAt: '2026-08-23T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    },
    activeSourceControlLaunchPlatform: 'linux',
    activeWorktree: null,
    activeWorktreeId: 'wt-1',
    agentComposerState,
    aiActionDisabledReason: undefined,
    canTargetPRComments: true,
    checks: [],
    checksLoading: false,
    claimedCommentResolutionRef,
    commentResolutionLaunchAcceptedRef,
    comments: [],
    commentsDisabledReason: undefined,
    commentsLoading: false,
    commentsSelectionClearRequest: null,
    conflictDetailsRefreshing: false,
    consumeClaimedCommentResolutionAfterDeliveryRef:
      ack.consumeClaimedCommentResolutionAfterDeliveryRef,
    detachedHeadDisplay: null,
    editingTitle: false,
    getGitLabProjectRef: vi.fn(() => null),
    handleAddPRComment: vi.fn(),
    handleCancelEdit: vi.fn(),
    handleDeleteComment: vi.fn(),
    handleEditComment: vi.fn(),
    handleFixChecksWithAI: vi.fn(),
    handleLaunchAborted: ack.handleLaunchAborted,
    handleLaunchAccepted: ack.handleLaunchAccepted,
    handleLinkAnotherReview: vi.fn(),
    handleLoadCheckDetails: vi.fn(),
    handleOpenPR: vi.fn(),
    handleRefresh: vi.fn(),
    handleOpenStackPR: vi.fn(),
    handleReplyToComment: vi.fn(),
    handleResolve: vi.fn(),
    handleResolveCommentsWithAI: vi.fn(),
    handleResolveConflictsWithAI: vi.fn(),
    handleSaveTitle: vi.fn(),
    handleSetReaction: vi.fn(),
    handleStartEdit: vi.fn(),
    handleTitleKeyDown: vi.fn(),
    handleUnlinkReview: vi.fn(),
    isFixingChecksWithAI: false,
    isRefreshing: false,
    isResolvingConflictsWithAI: false,
    linkedGitLabMR: null,
    pendingCommentResolutionRef,
    pr: null,
    prRefreshState: undefined,
    repo: null,
    refreshHostedReviewAfterMutation: vi.fn(),
    resolveCommentsWithAIDisabledReason: undefined,
    saveLaunchActionDefault: vi.fn(),
    setAgentComposerState,
    setChecksPanelContentRef: vi.fn(),
    settings: null,
    sourceControlAiActionsVisible: true,
    stateRequestKey: REVIEW_KEY,
    titleDraft: '',
    setTitleDraft: vi.fn(),
    titleInputRef: { current: null },
    titleSaving: false
  } satisfies ChecksPanelActiveContentModel
  return <ChecksPanelActiveContent model={model} ReviewHeaderComponent={() => null} />
}

let initialState: AppState

function renderPanel(
  provider: 'github' | 'gitlab',
  connectionId: string | null = null
): { resolution: PendingPRCommentAiAck; handle: HarnessHandle } {
  const resolution = resolutionFor(provider)
  const handle: HarnessHandle = { pendingRef: { current: null } }
  // Why: mirrors useChecksPanelAiQueue, which queues both the ref and the durable slot.
  setPendingPRCommentAiAck(resolution)
  render(
    <TooltipProvider>
      <Harness resolution={resolution} connectionId={connectionId} handle={handle} />
    </TooltipProvider>
  )
  return { resolution, handle }
}

function asButton(element: HTMLElement): HTMLButtonElement {
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error('expected a button')
  }
  return element
}

function startButton(): HTMLButtonElement {
  return asButton(screen.getByRole('button', { name: /start agent/i }))
}

function promptTemplate(): HTMLTextAreaElement {
  const element = screen.getByLabelText('Prompt template')
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error('expected the prompt template textarea')
  }
  return element
}

async function waitForDetectedAgents(): Promise<void> {
  await waitFor(() => expect(startButton().disabled).toBe(false))
}

function runningAgentRow(): HTMLButtonElement {
  return asButton(screen.getByRole('menuitem', { name: /Claude session/ }))
}

function hostWrites(): number {
  return (
    mocks.resolveReviewThread.mock.calls.length +
    mocks.resolveGitLabMRDiscussionForChecks.mock.calls.length +
    mocks.addPRReviewCommentReply.mock.calls.length +
    mocks.addPRConversationComment.mock.calls.length
  )
}

describe('checks panel: resolve PR comments in a running agent', () => {
  beforeEach(() => {
    ;(
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true
    vi.clearAllMocks()
    setLocalRuntimeCapabilitiesForTests(null)
    clearPendingPRCommentAiAck()
    initialState = useAppStore.getState()
    const base = getDefaultSettings(path.resolve('tmp'))
    useAppStore.setState(
      {
        ...initialState,
        settings: {
          ...base,
          defaultTuiAgent: 'codex',
          disabledTuiAgents: [],
          sourceControlAi: { ...base.sourceControlAi!, enabled: true, actions: {} }
        },
        ensureDetectedAgents: mocks.ensureDetectedAgents,
        ensureRemoteDetectedAgents: mocks.ensureRemoteDetectedAgents
      },
      true
    )
    mocks.ensureDetectedAgents.mockResolvedValue(['codex'])
    mocks.ensureRemoteDetectedAgents.mockResolvedValue(['codex'])
    mocks.planSourceControlAgentActionLaunch.mockReturnValue({
      ok: true,
      summary: 'Ready to launch.',
      commandLabel: 'codex',
      caveat: 'The prompt will be submitted after the agent is ready.'
    })
    mocks.noteTargets = [ELIGIBLE_TARGET]
    mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
    mocks.resolveReviewThread.mockResolvedValue(true)
    mocks.resolveGitLabMRDiscussionForChecks.mockResolvedValue({ ok: true })
  })
  afterEach(() => {
    cleanup()
    clearPendingPRCommentAiAck()
    useAppStore.setState(initialState, true)
    setLocalRuntimeCapabilitiesForTests(null)
  })

  it('delivers the edited prompt to the chosen GitHub session, then resolves the threads', async () => {
    renderPanel('github')
    await waitForDetectedAgents()
    fireEvent.change(promptTemplate(), {
      target: { value: '{basePrompt}\nKeep the diff small.' }
    })

    await act(async () => runningAgentRow().click())

    expect(mocks.sendNotesToActiveAgentSession).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      prompt: `${BASE_PROMPT}\nKeep the diff small.`,
      noteTarget: { tabId: 'tab-a', leafId: ELIGIBLE_TARGET.leafId }
    })
    await waitFor(() =>
      expect(mocks.resolveReviewThread).toHaveBeenCalledWith('/repo', 42, 'T1', true, {
        repoId: 'repo-1'
      })
    )
    expect(mocks.launchAgentInNewTab).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(takePendingPRCommentAiAck()).toBeNull()
  })

  it('resolves GitLab discussions only after delivery over an SSH connection', async () => {
    renderPanel('gitlab', 'ssh-1')
    await waitForDetectedAgents()

    await act(async () => runningAgentRow().click())

    await waitFor(() =>
      expect(mocks.resolveGitLabMRDiscussionForChecks).toHaveBeenCalledWith(
        expect.objectContaining({ repoId: 'repo-1', iid: 7, discussionId: 'D1', resolved: true })
      )
    )
    expect(mocks.ensureRemoteDetectedAgents).toHaveBeenCalledWith('ssh-1')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the queue and edited prompt when delivery fails, and a retry acknowledges', async () => {
    const { resolution, handle } = renderPanel('github')
    await waitForDetectedAgents()
    fireEvent.change(promptTemplate(), {
      target: { value: '{basePrompt} (retry)' }
    })
    mocks.sendNotesToActiveAgentSession.mockResolvedValueOnce({ status: 'not-ready' })

    await act(async () => runningAgentRow().click())

    await waitFor(() => expect(handle.pendingRef.current).toBe(resolution))
    expect(hostWrites()).toBe(0)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(promptTemplate().value).toBe('{basePrompt} (retry)')

    await act(async () => runningAgentRow().click())

    await waitFor(() => expect(mocks.resolveReviewThread).toHaveBeenCalledTimes(1))
    expect(mocks.sendNotesToActiveAgentSession).toHaveBeenLastCalledWith(
      expect.objectContaining({ prompt: `${BASE_PROMPT} (retry)` })
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('keeps the queue when the transport throws', async () => {
    const { resolution, handle } = renderPanel('gitlab')
    await waitForDetectedAgents()
    mocks.sendNotesToActiveAgentSession.mockRejectedValueOnce(new Error('relay gone'))

    await act(async () => runningAgentRow().click())

    await waitFor(() => expect(handle.pendingRef.current).toBe(resolution))
    expect(hostWrites()).toBe(0)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('refuses a session that went stale after the menu rendered, without sending', async () => {
    const { resolution, handle } = renderPanel('github')
    await waitForDetectedAgents()
    mocks.noteTargets = [
      { ...ELIGIBLE_TARGET, status: 'disabled', disabledReason: 'Agent status is stale' }
    ]

    await act(async () => runningAgentRow().click())

    expect(mocks.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
    expect(handle.pendingRef.current).toBe(resolution)
    expect(hostWrites()).toBe(0)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('leaves the new-session launch unchanged and acknowledges after its delivery', async () => {
    mocks.launchAgentInNewTab.mockReturnValue({
      surface: { kind: 'native-chat' },
      promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
    })
    renderPanel('github')
    await waitForDetectedAgents()

    await act(async () => startButton().click())

    await waitFor(() => expect(mocks.resolveReviewThread).toHaveBeenCalledTimes(1))
    expect(mocks.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'codex',
        worktreeId: 'wt-1',
        prompt: BASE_PROMPT,
        promptDelivery: 'submit-after-ready',
        launchSource: 'task_page'
      })
    )
    expect(mocks.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
  })
})
