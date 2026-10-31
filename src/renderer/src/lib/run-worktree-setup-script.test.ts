import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  toastInfo,
  toastError,
  ensureHooksConfirmed,
  activateAndRevealWorktree,
  getState,
  prepareSetupRunner
} = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastError: vi.fn(),
  ensureHooksConfirmed: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  getState: vi.fn(),
  prepareSetupRunner: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { info: toastInfo, error: toastError })
}))

vi.mock('@/lib/ensure-hooks-confirmed', () => ({
  ensureHooksConfirmed
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree
}))

vi.mock('@/store', () => ({
  useAppStore: { getState }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { runWorktreeSetupScript } from './run-worktree-setup-script'

const setupLaunch = {
  runnerScriptPath: '/repo/.git/orca/setup-runner.sh',
  envVars: { ORCA_ROOT_PATH: '/repo', ORCA_WORKTREE_PATH: '/repo-feature' }
}

type MockRepo = {
  id: string
  kind?: 'git' | 'folder'
  connectionId?: string | null
  executionHostId?: string | null
}

function mockStore(overrides?: {
  worktree?: { id: string; repoId: string; path: string; hostId?: string } | null
  repos?: MockRepo[]
}): void {
  const worktree =
    overrides && 'worktree' in overrides
      ? overrides.worktree
      : { id: 'wt-1', repoId: 'repo-1', path: '/repo-feature' }
  const repos = overrides?.repos ?? [{ id: 'repo-1', kind: 'git' as const, connectionId: null }]

  getState.mockReturnValue({
    getKnownWorktreeById: (id: string) => (worktree && worktree.id === id ? worktree : undefined),
    repos,
    settings: undefined
  })
}

describe('runWorktreeSetupScript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore()
    ensureHooksConfirmed.mockResolvedValue('run')
    prepareSetupRunner.mockResolvedValue({
      status: 'ok',
      setup: setupLaunch,
      setupScript: 'pnpm install',
      setupScriptSource: 'yaml'
    })
    activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    globalThis.window = {
      api: {
        hooks: {
          prepareSetupRunner
        }
      }
    } as unknown as typeof globalThis.window
  })

  it('skips when the worktree is missing', async () => {
    mockStore({ worktree: null })

    const result = await runWorktreeSetupScript('wt-missing')

    expect(result).toEqual({ status: 'skipped', reason: 'worktree-missing' })
    expect(toastError).toHaveBeenCalled()
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('skips when the repo row is gone', async () => {
    mockStore({ repos: [] })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'repo-missing' })
    expect(toastError).toHaveBeenCalled()
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('resolves the repo row by the worktree host when repo ids are duplicated', async () => {
    mockStore({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo-feature', hostId: 'local' },
      repos: [
        { id: 'repo-1', kind: 'git', connectionId: 'ssh-target' },
        { id: 'repo-1', kind: 'git', connectionId: null }
      ]
    })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'launched', primaryTabId: 'tab-1' })
    expect(prepareSetupRunner).toHaveBeenCalledWith({
      repoId: 'repo-1',
      worktreePath: '/repo-feature',
      hostId: 'local'
    })
  })

  it('skips folder repos without preparing a runner', async () => {
    mockStore({ repos: [{ id: 'repo-1', kind: 'folder' }] })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'folder-repo' })
    expect(toastInfo).toHaveBeenCalledWith('Folder workspaces do not use setup scripts.')
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('rejects SSH repos before the trust gate with a visible toast', async () => {
    mockStore({ repos: [{ id: 'repo-1', kind: 'git', connectionId: 'ssh-target' }] })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'remote-host' })
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('not yet supported'))
    expect(ensureHooksConfirmed).not.toHaveBeenCalled()
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('rejects runtime-host repos even without a connectionId', async () => {
    mockStore({
      repos: [{ id: 'repo-1', kind: 'git', connectionId: null, executionHostId: 'runtime:env-1' }]
    })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'remote-host' })
    expect(ensureHooksConfirmed).not.toHaveBeenCalled()
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('rejects worktrees owned by a non-local host even when the repo row is local', async () => {
    mockStore({
      worktree: { id: 'wt-1', repoId: 'repo-1', path: '/repo-feature', hostId: 'ssh:box' },
      repos: [
        { id: 'repo-1', kind: 'git', connectionId: null },
        { id: 'repo-1', kind: 'git', connectionId: 'box' }
      ]
    })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'remote-host' })
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('maps an IPC remote-host rejection to an info toast', async () => {
    prepareSetupRunner.mockResolvedValue({
      status: 'error',
      setup: null,
      reason: 'remote-host',
      message: 'Run setup script is not yet supported for remote worktrees.'
    })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'remote-host' })
    expect(toastInfo).toHaveBeenCalledWith(expect.stringContaining('not yet supported'))
    expect(toastError).not.toHaveBeenCalled()
  })

  it('confirms trust against the script returned by the runner preparation', async () => {
    const result = await runWorktreeSetupScript('wt-1')

    expect(prepareSetupRunner).toHaveBeenCalledWith({
      repoId: 'repo-1',
      worktreePath: '/repo-feature',
      hostId: 'local'
    })
    expect(ensureHooksConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      'setup',
      'local',
      undefined,
      { scriptContentOverride: 'pnpm install' }
    )
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      setup: setupLaunch,
      executionHostId: 'local'
    })
    expect(result).toEqual({ status: 'launched', primaryTabId: 'tab-1' })
  })

  it('prefers the canonical trustContent over the raw script for the trust gate', async () => {
    prepareSetupRunner.mockResolvedValue({
      status: 'ok',
      setup: setupLaunch,
      setupScript: 'pnpm install',
      setupScriptSource: 'yaml',
      trustContent: 'pnpm install\n\n# defaultTabs[1]\nnpm run dev'
    })

    await runWorktreeSetupScript('wt-1')

    expect(ensureHooksConfirmed).toHaveBeenCalledWith(
      expect.anything(),
      'repo-1',
      'setup',
      'local',
      undefined,
      { scriptContentOverride: 'pnpm install\n\n# defaultTabs[1]\nnpm run dev' }
    )
  })

  it('skips the trust prompt for user-owned local Settings scripts', async () => {
    prepareSetupRunner.mockResolvedValue({
      status: 'ok',
      setup: setupLaunch,
      setupScript: 'pnpm install',
      setupScriptSource: 'local'
    })

    const result = await runWorktreeSetupScript('wt-1')

    expect(ensureHooksConfirmed).not.toHaveBeenCalled()
    expect(result).toEqual({ status: 'launched', primaryTabId: 'tab-1' })
  })

  it('stops when setup trust is declined', async () => {
    ensureHooksConfirmed.mockResolvedValue('skip')

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'trust-skipped' })
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('toasts when no setup script is configured', async () => {
    prepareSetupRunner.mockResolvedValue({
      status: 'ok',
      setup: null,
      reason: 'no-setup-configured'
    })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'no-setup-configured' })
    expect(toastInfo).toHaveBeenCalledWith('No setup script is configured for this project.')
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('surfaces runner preparation failures without activating', async () => {
    prepareSetupRunner.mockResolvedValue({
      status: 'error',
      setup: null,
      reason: 'runner-failed',
      message: 'permission denied'
    })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'error', message: 'permission denied' })
    expect(toastError).toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('surfaces rejected preparation IPC calls as errors', async () => {
    prepareSetupRunner.mockRejectedValue(new Error('ipc unavailable'))

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'error', message: 'ipc unavailable' })
    expect(toastError).toHaveBeenCalled()
    expect(activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('reports activation failures with a toast', async () => {
    activateAndRevealWorktree.mockReturnValue(false)

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'activation-failed' })
    expect(toastError).toHaveBeenCalled()
  })
})
