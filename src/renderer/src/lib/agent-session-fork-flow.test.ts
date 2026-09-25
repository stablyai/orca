import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type {
  WorktreeDefaultTabsLaunch,
  WorktreeSetupLaunch
} from '../../../shared/worktree/launch-types'
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

type CreatedWorktree = {
  worktree: { id: string; path: string }
  setup?: WorktreeSetupLaunch
  defaultTabs?: WorktreeDefaultTabsLaunch
}

const createWorktree = vi.fn(async (..._args: unknown[]): Promise<CreatedWorktree> => ({
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
  writeTerminalClipboardText: vi.fn(async (_text: string) => undefined),
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
    base: { kind: 'parent-commit' },
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
  vi.stubGlobal('window', {
    api: { ui: { writeTerminalClipboardText: mocks.writeTerminalClipboardText } }
  })
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
      request({ sourceHeadOid: 'a'.repeat(40), base: { kind: 'parent-commit' }, asChild: true }),
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
    await runAgentSessionFork(
      request({ base: { kind: 'ref', ref: 'main' }, carryChanges: true }),
      onStage
    )
    const call = createCall()
    expect(call[2]).toBe('main')
    expect(call[24]).toBeUndefined()
    expect(mocks.carryRuntimeWorkingTreeChanges).not.toHaveBeenCalled()
    expect(onStage.mock.calls.map(([stage]) => stage)).toEqual(['creating', 'launching'])
  })

  it('lets createWorktree resolve the repo default base, without carrying or a compare ref', async () => {
    await runAgentSessionFork(
      request({ base: { kind: 'repo-default' }, carryChanges: true }),
      onStage
    )
    const call = createCall()
    expect(call[2]).toBeUndefined()
    expect(call[24]).toBeUndefined()
    expect(mocks.carryRuntimeWorkingTreeChanges).not.toHaveBeenCalled()
  })

  it('starts from the parent branch when the parent commit is unknown', async () => {
    await runAgentSessionFork(request({ sourceHeadOid: null, carryChanges: true }), onStage)
    const call = createCall()
    expect(call[2]).toBe('feedback')
    expect(call[24]).toBeUndefined()
    expect(mocks.carryRuntimeWorkingTreeChanges).not.toHaveBeenCalled()
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
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith('repo::feedback-fork', {
      sidebarRevealBehavior: 'auto',
      providesInitialSurface: true
    })
  })

  it('hands the setup script and default tabs to activation, after the carry and before the agent tab', async () => {
    const setup = { runnerScriptPath: '/r/feedback-fork/.orca/setup.sh', envVars: {} }
    const defaultTabs: WorktreeDefaultTabsLaunch = {
      tabs: [{ title: 'Dev', command: 'pnpm dev' }],
      runCommands: true
    }
    createWorktree.mockResolvedValueOnce({
      worktree: { id: 'repo::feedback-fork', path: '/r/feedback-fork' },
      setup,
      defaultTabs
    })

    await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith('repo::feedback-fork', {
      sidebarRevealBehavior: 'auto',
      setup,
      defaultTabs,
      providesInitialSurface: true
    })
    const carryOrder = mocks.carryRuntimeWorkingTreeChanges.mock.invocationCallOrder[0] ?? 0
    const activateOrder = mocks.activateAndRevealWorktree.mock.invocationCallOrder[0] ?? 0
    const launchOrder = mocks.launchNativeAgentSessionFork.mock.invocationCallOrder[0] ?? 0
    expect(carryOrder).toBeLessThan(activateOrder)
    expect(activateOrder).toBeLessThan(launchOrder)
  })

  it('lets activation seed the workspace when no agent is launched', async () => {
    const setup = { runnerScriptPath: '/r/feedback-fork/.orca/setup.sh', envVars: {} }
    createWorktree.mockResolvedValueOnce({
      worktree: { id: 'repo::feedback-fork', path: '/r/feedback-fork' },
      setup
    })

    await runAgentSessionFork(request({ source: { kind: 'none' } }), onStage)

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith('repo::feedback-fork', {
      sidebarRevealBehavior: 'auto',
      setup
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

  it.each([
    ['runtime_rpc_queue_overloaded', 'Remote runtime call queue is full.'],
    [
      'remote_runtime_unavailable',
      'Remote Orca runtime request was released before it could be sent.'
    ],
    ['method_not_found', 'Unknown method: git.carryWorkingTreeChanges']
  ])('keeps apply_failed when the runtime request never ran (%s)', async (code, message) => {
    mocks.carryRuntimeWorkingTreeChanges.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'git.carryWorkingTreeChanges',
        ok: false,
        error: { code, message }
      })
    )

    const outcome = await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'changes-not-carried', reason: 'apply_failed' }]
    })
  })

  it.each([
    ['remote_runtime_unavailable', 'Remote Orca runtime closed the connection.'],
    ['reconnecting', 'Remote Orca runtime is reconnecting.'],
    ['timeout', 'Timed out waiting for the remote Orca runtime.']
  ])('reports an uncertain carry when contact is lost mid-request (%s)', async (code, message) => {
    mocks.carryRuntimeWorkingTreeChanges.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'git.carryWorkingTreeChanges',
        ok: false,
        error: { code, message }
      })
    )

    const outcome = await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'changes-not-carried', reason: 'partially_applied' }]
    })
  })

  it('reports an uncertain carry when the runtime call times out', async () => {
    mocks.carryRuntimeWorkingTreeChanges.mockRejectedValue(
      new RuntimeRpcCallError({
        id: 'git.carryWorkingTreeChanges',
        ok: false,
        error: {
          code: 'runtime_timeout',
          message: 'Timed out waiting for the remote Orca runtime to respond.'
        }
      })
    )

    const outcome = await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'changes-not-carried', reason: 'partially_applied' }]
    })
    expect(mocks.launchNativeAgentSessionFork).toHaveBeenCalledTimes(1)
  })

  it('reports an uncertain carry when the web client call times out', async () => {
    // Why: the web preload rethrows a failed envelope as a plain Error that keeps the code.
    mocks.carryRuntimeWorkingTreeChanges.mockRejectedValue(
      Object.assign(new Error('Timed out waiting for the remote Orca runtime to respond.'), {
        code: 'runtime_timeout'
      })
    )

    const outcome = await runAgentSessionFork(request({ carryChanges: true }), onStage)

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'changes-not-carried', reason: 'partially_applied' }]
    })
  })

  it('warns when the native fork cannot start', async () => {
    mocks.launchNativeAgentSessionFork.mockResolvedValue(false)

    const outcome = await runAgentSessionFork(request(), onStage)

    expect(outcome).toEqual({
      ok: true,
      worktreeId: 'repo::feedback-fork',
      warnings: [{ kind: 'agent-not-started' }]
    })
    expect(mocks.writeTerminalClipboardText).not.toHaveBeenCalled()
    // Why: the first activation left the surface to the agent tab, so a failed launch reseeds a shell.
    expect(mocks.activateAndRevealWorktree.mock.calls).toEqual([
      ['repo::feedback-fork', { sidebarRevealBehavior: 'auto', providesInitialSurface: true }],
      ['repo::feedback-fork', { sidebarRevealBehavior: 'auto' }]
    ])
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
    expect(mocks.writeTerminalClipboardText).not.toHaveBeenCalled()
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
    expect(mocks.writeTerminalClipboardText).toHaveBeenCalledWith('fork context')
    expect(mocks.toastMessage).toHaveBeenCalledTimes(1)
    expect(mocks.activateAndRevealWorktree).toHaveBeenLastCalledWith('repo::feedback-fork', {
      sidebarRevealBehavior: 'auto'
    })
  })

  it('still returns the fork when copying the transcript prompt fails', async () => {
    mocks.launchTranscriptAgentSessionFork.mockResolvedValue(false)
    mocks.writeTerminalClipboardText.mockRejectedValue(new Error('clipboard denied'))

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
