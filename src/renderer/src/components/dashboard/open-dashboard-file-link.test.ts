import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openDetectedFilePath, getKnownWorktreeById, resolvePaneWslDistro, getConnectionId } =
  vi.hoisted(() => ({
    openDetectedFilePath: vi.fn(),
    getKnownWorktreeById: vi.fn((): { id: string; path: string } | undefined => ({
      id: 'wt-1',
      path: '/Users/dev/work/feature'
    })),
    resolvePaneWslDistro: vi.fn((): string | null => null),
    getConnectionId: vi.fn((): string | null => null)
  }))

vi.mock('@/components/terminal-pane/terminal-link-handlers', () => ({ openDetectedFilePath }))
vi.mock('@/components/terminal-pane/terminal-pane-wsl-distro', () => ({ resolvePaneWslDistro }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ getKnownWorktreeById }) }
}))

import { openDashboardFileLink } from './open-dashboard-file-link'

describe('openDashboardFileLink', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getKnownWorktreeById.mockReturnValue({ id: 'wt-1', path: '/Users/dev/work/feature' })
    resolvePaneWslDistro.mockReturnValue(null)
    getConnectionId.mockReturnValue(null)
  })

  it('resolves a printed relative path against the card workspace', () => {
    openDashboardFileLink({
      worktreeId: 'wt-1',
      path: 'src/app.ts',
      line: 12,
      column: 3
    })

    expect(getKnownWorktreeById).toHaveBeenCalledWith('wt-1', undefined)
    expect(openDetectedFilePath).toHaveBeenCalledWith(
      '/Users/dev/work/feature/src/app.ts',
      12,
      3,
      expect.objectContaining({
        worktreeId: 'wt-1',
        worktreePath: '/Users/dev/work/feature',
        runtimeEnvironmentId: null,
        openWithSystemDefault: false
      })
    )
  })

  it('keeps an absolute path as the terminal printed it', () => {
    openDashboardFileLink({
      worktreeId: 'wt-1',
      path: '/etc/hosts',
      line: null,
      column: null,
      openWithSystemDefault: true
    })

    expect(openDetectedFilePath).toHaveBeenCalledWith(
      '/etc/hosts',
      null,
      null,
      expect.objectContaining({ openWithSystemDefault: true })
    )
  })

  it('routes a runtime-hosted card to its runtime environment', () => {
    openDashboardFileLink({
      worktreeId: 'wt-1',
      executionHostId: 'runtime:box-7',
      path: 'src/app.ts',
      line: null,
      column: null
    })

    expect(getKnownWorktreeById).toHaveBeenCalledWith('wt-1', 'runtime:box-7')
    expect(openDetectedFilePath).toHaveBeenCalledWith(
      '/Users/dev/work/feature/src/app.ts',
      null,
      null,
      expect.objectContaining({ runtimeEnvironmentId: 'box-7' })
    )
  })

  it('never lets a local WSL distro rewrite an SSH workspace path', () => {
    getConnectionId.mockReturnValue('ssh-target-2')

    openDashboardFileLink({
      worktreeId: 'wt-1',
      executionHostId: 'ssh:ssh-target-2',
      path: 'src/app.ts',
      line: null,
      column: null
    })

    expect(resolvePaneWslDistro).not.toHaveBeenCalled()
    expect(openDetectedFilePath).toHaveBeenCalledWith(
      expect.any(String),
      null,
      null,
      expect.objectContaining({ wslDistro: null })
    )
  })

  it('still opens an absolute path when the workspace is no longer known', () => {
    getKnownWorktreeById.mockReturnValue(undefined)

    openDashboardFileLink({
      worktreeId: 'gone',
      path: '/Users/dev/work/feature/src/app.ts',
      line: null,
      column: null
    })

    expect(openDetectedFilePath).toHaveBeenCalledWith(
      '/Users/dev/work/feature/src/app.ts',
      null,
      null,
      expect.objectContaining({ worktreePath: '' })
    )
  })
})
