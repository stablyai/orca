import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'

import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { createProviderSetup, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import { installTerminalLinkTestEnvironment } from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const { storeState } = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

installTerminalLinkTestEnvironment(doubles)

describe('createFilePathLinkProvider range bounds', () => {
  it('resolves relative POSIX terminal links against the pane cwd before mapping', async () => {
    const mappedPath = '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md'
    vi.mocked(window.api.shell.pathExists).mockImplementation(
      async (pathValue) => pathValue === mappedPath
    )
    const { provider } = createProviderSetup([makeBufferLine('README.md:5')], new Map(), {
      worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\repo',
      wslDistro: 'Ubuntu',
      startupCwd: '/stale',
      getPaneLinkCwd: () => '/root/workspace/myrepo'
    })

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(links).toHaveLength(1)
    expect(window.api.shell.pathExists).toHaveBeenCalledWith(mappedPath)
  })

  it('maps POSIX terminal links for a WSL-runtime pane on a Windows-drive worktree', async () => {
    const mappedPath = 'C:\\repo\\src\\main.ts'
    vi.mocked(window.api.shell.pathExists).mockImplementation(
      async (pathValue) => pathValue === mappedPath
    )
    const { provider } = createProviderSetup([makeBufferLine('src/main.ts:5')], new Map(), {
      worktreePath: 'C:\\repo',
      wslDistro: 'Ubuntu',
      startupCwd: '/mnt/c/repo',
      getPaneLinkCwd: () => '/mnt/c/repo'
    })

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(links).toHaveLength(1)
    expect(window.api.shell.pathExists).toHaveBeenCalledWith(mappedPath)
  })
})
