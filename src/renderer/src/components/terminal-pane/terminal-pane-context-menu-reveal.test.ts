import { beforeEach, describe, expect, it, vi } from 'vitest'
import { revealTerminalPaneContextPath } from './terminal-pane-context-menu-reveal'
import { resolveSplitCwd } from './resolve-split-cwd'
import { revealInFileManager } from '@/lib/reveal-in-file-manager'

vi.mock('./resolve-split-cwd', () => ({
  resolveSplitCwd: vi.fn()
}))
vi.mock('@/lib/reveal-in-file-manager', () => ({
  revealInFileManager: vi.fn()
}))

const capturedFilePath = (): Promise<string> => Promise.resolve('/repo/src/app.ts')

const baseArgs = {
  capturedFilePath: null,
  fallbackCwd: '/repo',
  paneCwdMap: new Map(),
  paneId: 3,
  ptyId: 'pty-3',
  revealBlocked: false,
  revealOwner: 'local' as const,
  runtimeEnvironmentId: null,
  worktreePath: '/repo',
  wslDistro: null
}

describe('revealTerminalPaneContextPath', () => {
  beforeEach(() => {
    vi.mocked(resolveSplitCwd).mockReset()
    vi.mocked(revealInFileManager).mockReset()
  })

  it('reveals the captured file without resolving the pane cwd', async () => {
    await revealTerminalPaneContextPath({
      ...baseArgs,
      capturedFilePath
    })

    expect(resolveSplitCwd).not.toHaveBeenCalled()
    expect(revealInFileManager).toHaveBeenCalledWith('/repo/src/app.ts', 'local')
  })

  it('resolves and reveals the pane cwd when no file was captured', async () => {
    vi.mocked(resolveSplitCwd).mockResolvedValue('/repo/packages/web')

    await revealTerminalPaneContextPath(baseArgs)

    expect(resolveSplitCwd).toHaveBeenCalledWith({
      paneCwdMap: baseArgs.paneCwdMap,
      sourcePaneId: 3,
      sourcePtyId: 'pty-3',
      fallbackCwd: '/repo'
    })
    expect(revealInFileManager).toHaveBeenCalledWith('/repo/packages/web', 'local')
  })

  it('does not resolve or reveal a path for a blocked owner', async () => {
    await revealTerminalPaneContextPath({
      ...baseArgs,
      capturedFilePath,
      revealBlocked: true,
      revealOwner: 'ssh:build'
    })

    expect(resolveSplitCwd).not.toHaveBeenCalled()
    expect(revealInFileManager).not.toHaveBeenCalled()
  })
})
