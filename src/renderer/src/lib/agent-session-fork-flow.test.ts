import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForkableAgentSession } from './worktree-agent-fork-sessions'
import {
  runAgentSessionFork,
  type AgentSessionForkRequest,
  type AgentSessionForkStage
} from './agent-session-fork-flow'

type Worktree = {
  id: string
  repoId: string
  path: string
  branch: string
  displayName: string
}
type Repo = { id: string; connectionId: string | null }
type Settings = { activeRuntimeEnvironmentId: string | null }
type MockState = {
  createWorktree: typeof createWorktree
  getKnownWorktreeById: (id: string) => Worktree | undefined
  repos: Repo[]
  settings: Settings
}

const createWorktree = vi.fn(async (..._args: unknown[]) => ({
  worktree: { id: 'repo::feedback-fork', path: '/r/feedback-fork' }
}))
const knownWorktrees = new Map<string, Worktree>()
const state: MockState = {
  createWorktree,
  getKnownWorktreeById: (id: string): Worktree | undefined => knownWorktrees.get(id),
  repos: [],
  settings: { activeRuntimeEnvironmentId: null }
}

const mocks = vi.hoisted(() => ({
  carryRuntimeWorkingTreeChanges: vi.fn(),
  launchNativeAgentSessionFork: vi.fn(),
  launchTranscriptAgentSessionFork: vi.fn(),
  activateAndRevealWorktree: vi.fn((_worktreeId: string, _options?: unknown) => true),
  settingsForRepoOwner: vi.fn((_state: unknown, _repoId: string) => ({
    activeRuntimeEnvironmentId: 'owner-env'
  })),
  writeClipboardText: vi.fn(async (_text: string) => undefined),
  toastMessage: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/store/repos/owner-routing', () => ({
  settingsForRepoOwner: mocks.settingsForRepoOwner
}))
vi.mock('@/runtime/runtime-git-working-tree-carry-client', () => ({
  carryRuntimeWorkingTreeChanges: mocks.carryRuntimeWorkingTreeChanges
}))
vi.mock('./agent-session-fork-launch', () => ({
  launchNativeAgentSessionFork: mocks.launchNativeAgentSessionFork,
  launchTranscriptAgentSessionFork: mocks.launchTranscriptAgentSessionFork
}))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('sonner', () => ({
  toast: { message: mocks.toastMessage, error: mocks.toastError }
}))

const claudeSession: ForkableAgentSession = {
  providerSessionId: 'sess-1',
  paneKey: 'tab-1:leaf-1',
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'sess-1' },
  launchConfig: null,
  title: 'Claude',
  lastActiveAt: 1,
  live: true
}

function request(overrides: Partial<AgentSessionForkRequest> = {}): AgentSessionForkRequest {
  return {
    sourceWorktreeId: 'repo::feedback',
    name: 'feedback-fork',
    source: { kind: 'native', session: claudeSession },
    asChild: true,
    carryChanges: false,
    sourceHeadOid: 'a'.repeat(40),
    baseBranchOverride: null,
    launchSource: 'sidebar',
    ...overrides
  }
}

const onStage = vi.fn((_stage: AgentSessionForkStage) => undefined)

function createCall(): unknown[] {
  const call = createWorktree.mock.calls[0]
  if (!call) {
    throw new Error('createWorktree was not called')
  }
  return call
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('window', { api: { ui: { writeClipboardText: mocks.writeClipboardText } } })
  state.repos = [{ id: 'repo', connectionId: 'ssh-1' }]
  state.settings = { activeRuntimeEnvironmentId: null }
  knownWorktrees.clear()
  knownWorktrees.set('repo::feedback', {
    id: 'repo::feedback',
    repoId: 'repo',
    path: '/r/feedback',
    branch: 'refs/heads/feedback',
    displayName: 'feedback'
  })
  mocks.carryRuntimeWorkingTreeChanges.mockResolvedValue({
    ok: true,
    trackedChanges: true,
    untrackedCopied: 1
  })
  mocks.launchNativeAgentSessionFork.mockResolvedValue(true)
  mocks.launchTranscriptAgentSessionFork.mockResolvedValue(true)
})

describe('runAgentSessionFork', () => {
  it('creates a child worktree at the parent commit and compares against the parent branch', async () => {
    await runAgentSessionFork(
      request({ sourceHeadOid: 'a'.repeat(40), baseBranchOverride: null, asChild: true }),
      onStage
    )
    const call = createCall()
    expect(call).toHaveLength(26)
    expect(call[0]).toBe('repo')
    expect(call[1]).toBe('feedback-fork')
    expect(call[2]).toBe('a'.repeat(40))
    expect(call[3]).toBe('inherit')
    expect(call[5]).toBe('sidebar')
    expect(call[10]).toBe('claude')
    expect(call[24]).toBe('feedback')
    expect(call[25]).toEqual({ parentWorktreeId: 'repo::feedback' })
  })

  it('does not set a parent when asChild is false', async () => {
    await runAgentSessionFork(request({ asChild: false }), onStage)
    expect(createCall()[25] ?? {}).not.toHaveProperty('parentWorktreeId')
  })

  it('uses the override branch and skips carrying when a different base is chosen', async () => {
    await runAgentSessionFork(request({ baseBranchOverride: 'main', carryChanges: true }), onStage)
    const call = createCall()
    expect(call[2]).toBe('main')
    expect(call[24]).toBeUndefined()
    expect(mocks.carryRuntimeWorkingTreeChanges).not.toHaveBeenCalled()
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['creating', 'launching'])
  })

  it('carries changes before launching and reports stages in order', async () => {
    const outcome = await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(outcome).toEqual({ ok: true, worktreeId: 'repo::feedback-fork', warnings: [] })
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual([
      'creating',
      'carrying',
      'launching'
    ])
    expect(mocks.carryRuntimeWorkingTreeChanges).toHaveBeenCalledWith({
      settings: { activeRuntimeEnvironmentId: 'owner-env' },
      connectionId: 'ssh-1',
      source: { worktreeId: 'repo::feedback', worktreePath: '/r/feedback' },
      target: { worktreeId: 'repo::feedback-fork', worktreePath: '/r/feedback-fork' }
    })
    expect(mocks.settingsForRepoOwner).toHaveBeenCalledWith(state, 'repo')
    const carryOrder = mocks.carryRuntimeWorkingTreeChanges.mock.invocationCallOrder[0]
    const launchOrder = mocks.launchNativeAgentSessionFork.mock.invocationCallOrder[0]
    const createOrder = createWorktree.mock.invocationCallOrder[0]
    expect(createOrder).toBeLessThan(carryOrder ?? 0)
    expect(carryOrder).toBeLessThan(launchOrder ?? 0)
  })

  it('launches the native fork in the child with the repo connection', async () => {
    await runAgentSessionFork(request(), onStage)
    expect(mocks.launchNativeAgentSessionFork).toHaveBeenCalledWith({
      session: claudeSession,
      worktreeId: 'repo::feedback-fork',
      worktreePath: '/r/feedback-fork',
      connectionId: 'ssh-1',
      launchSource: 'sidebar'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::feedback-fork', {
      sidebarRevealBehavior: 'auto'
    })
  })

  it('keeps the worktree and warns when carrying fails', async () => {
    mocks.carryRuntimeWorkingTreeChanges.mockResolvedValue({ ok: false, reason: 'too_large' })

    const outcome = await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'changes-not-carried', reason: 'too_large' }]
    })
    expect(mocks.launchNativeAgentSessionFork).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
  })

  it('treats a rejected carry as a failed carry, not a failed fork', async () => {
    mocks.carryRuntimeWorkingTreeChanges.mockRejectedValue(new Error('host unreachable'))

    const outcome = await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'changes-not-carried', reason: 'apply_failed' }]
    })
    expect(mocks.launchNativeAgentSessionFork).toHaveBeenCalledTimes(1)
  })

  it('warns when the native fork cannot start', async () => {
    mocks.launchNativeAgentSessionFork.mockResolvedValue(false)

    const outcome = await runAgentSessionFork(request(), onStage)

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'agent-not-started' }]
    })
    expect(mocks.writeClipboardText).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledTimes(1)
  })

  it('launches the transcript fork with its agent and prompt', async () => {
    const outcome = await runAgentSessionFork(
      request({ source: { kind: 'transcript', agent: 'gemini', prompt: 'fork context' } }),
      onStage
    )

    expect(outcome).toEqual({ ok: true, worktreeId: 'repo::feedback-fork', warnings: [] })
    expect(createCall()[10]).toBe('gemini')
    expect(mocks.launchTranscriptAgentSessionFork).toHaveBeenCalledWith({
      agent: 'gemini',
      prompt: 'fork context',
      worktreeId: 'repo::feedback-fork',
      worktreePath: '/r/feedback-fork',
      launchSource: 'sidebar'
    })
    expect(mocks.writeClipboardText).not.toHaveBeenCalled()
  })

  it('copies the transcript prompt to the clipboard when the transcript fork cannot start', async () => {
    mocks.launchTranscriptAgentSessionFork.mockResolvedValue(false)

    const outcome = await runAgentSessionFork(
      request({
        source: { kind: 'transcript', agent: 'gemini', prompt: 'fork context' },
        launchSource: 'terminal_context_menu'
      }),
      onStage
    )

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'agent-not-started' }]
    })
    expect(mocks.writeClipboardText).toHaveBeenCalledWith('fork context')
    expect(mocks.toastMessage).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::feedback-fork', {
      sidebarRevealBehavior: 'auto'
    })
  })

  it('still returns the fork when copying the transcript prompt fails', async () => {
    mocks.launchTranscriptAgentSessionFork.mockResolvedValue(false)
    mocks.writeClipboardText.mockRejectedValue(new Error('clipboard denied'))

    const outcome = await runAgentSessionFork(
      request({ source: { kind: 'transcript', agent: 'gemini', prompt: 'fork context' } }),
      onStage
    )

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'agent-not-started' }]
    })
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('launches nothing for the none source', async () => {
    const outcome = await runAgentSessionFork(request({ source: { kind: 'none' } }), onStage)

    expect(outcome).toEqual({ ok: true, worktreeId: 'repo::feedback-fork', warnings: [] })
    expect(createCall()[10]).toBeUndefined()
    expect(mocks.launchNativeAgentSessionFork).not.toHaveBeenCalled()
    expect(mocks.launchTranscriptAgentSessionFork).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo::feedback-fork', {
      sidebarRevealBehavior: 'auto'
    })
  })

  it('returns the create error and launches nothing when the worktree cannot be created', async () => {
    createWorktree.mockRejectedValueOnce(new Error('boom'))

    const outcome = await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(outcome).toEqual({ ok: false, error: 'boom' })
    expect(mocks.carryRuntimeWorkingTreeChanges).not.toHaveBeenCalled()
    expect(mocks.launchNativeAgentSessionFork).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('fails without creating anything when the source workspace is gone', async () => {
    knownWorktrees.clear()

    const outcome = await runAgentSessionFork(request(), onStage)

    expect(outcome).toEqual({ ok: false, error: 'The source workspace no longer exists.' })
    expect(createWorktree).not.toHaveBeenCalled()
    expect(onStage).not.toHaveBeenCalled()
  })
})
