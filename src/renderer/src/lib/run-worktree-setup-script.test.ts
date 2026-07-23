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

function mockStore(overrides?: {
  worktree?: { id: string; repoId: string; path: string } | null
  repo?: { id: string; kind?: 'git' | 'folder'; connectionId?: string | null } | null
}): void {
  const worktree =
    overrides && 'worktree' in overrides
      ? overrides.worktree
      : { id: 'wt-1', repoId: 'repo-1', path: '/repo-feature' }
  const repo =
    overrides && 'repo' in overrides
      ? overrides.repo
      : { id: 'repo-1', kind: 'git' as const, connectionId: null }

  getState.mockReturnValue({
    getKnownWorktreeById: (id: string) => (worktree && worktree.id === id ? worktree : undefined),
    repos: repo ? [repo] : []
  })
}

describe('runWorktreeSetupScript', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore()
    ensureHooksConfirmed.mockResolvedValue('run')
    prepareSetupRunner.mockResolvedValue({ status: 'ok', setup: setupLaunch })
    activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'tab-1' })
    // @ts-expect-error test stub
    globalThis.window = {
      api: {
        hooks: {
          prepareSetupRunner
        }
      }
    }
  })

  it('skips when the worktree is missing', async () => {
    mockStore({ worktree: null })

    const result = await runWorktreeSetupScript('wt-missing')

    expect(result).toEqual({ status: 'skipped', reason: 'worktree-missing' })
    expect(toastError).toHaveBeenCalled()
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('skips folder repos without preparing a runner', async () => {
    mockStore({ repo: { id: 'repo-1', kind: 'folder' } })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'folder-repo' })
    expect(toastInfo).toHaveBeenCalledWith('Folder workspaces do not use setup scripts.')
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('stops when setup trust is declined', async () => {
    ensureHooksConfirmed.mockResolvedValue('skip')

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'trust-skipped' })
    expect(prepareSetupRunner).not.toHaveBeenCalled()
  })

  it('toasts when no setup script is configured', async () => {
    prepareSetupRunner.mockResolvedValue({
      status: 'ok',
      setup: null,
      reason: 'no-setup-configured'
    })

    const result = await runWorktreeSetupScript('wt-1')

    expect(result).toEqual({ status: 'skipped', reason: 'no-setup-configured' })
    expect(toastInfo).toHaveBeenCalledWith(
      'No setup script is configured for this project.'
    )
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

  it('prepares the runner and launches via activateAndRevealWorktree', async () => {
    const result = await runWorktreeSetupScript('wt-1')

    expect(prepareSetupRunner).toHaveBeenCalledWith({
      repoId: 'repo-1',
      worktreePath: '/repo-feature'
    })
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', { setup: setupLaunch })
    expect(result).toEqual({ status: 'launched', primaryTabId: 'tab-1' })
  })
})
