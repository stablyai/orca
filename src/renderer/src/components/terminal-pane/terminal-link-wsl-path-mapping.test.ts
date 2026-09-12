import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { mapTerminalFilePath, openDetectedFilePath } from './terminal-link-handlers'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { createProviderSetup, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import {
  flushAsyncWork,
  flushDoubleRaf,
  installTerminalLinkTestEnvironment,
  setPlatform
} from './terminal-link-handlers-test-harness'

const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  authorizeExternalPathMock,
  statMock,
  openFileMock,
  setPendingEditorRevealMock
} = doubles

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
  it.each([
    ['modern', '\\\\wsl.localhost\\Ubuntu\\home\\repo'],
    ['legacy', '\\\\wsl$\\Ubuntu\\home\\repo']
  ])('maps POSIX terminal links for a %s WSL worktree', async (_label, worktreePath) => {
    const mappedPath = '\\\\wsl.localhost\\Ubuntu\\root\\workspace\\myrepo\\README.md'
    vi.mocked(window.api.shell.pathExists).mockImplementation(
      async (pathValue) => pathValue === mappedPath
    )
    const { provider, linkTooltip } = createProviderSetup(
      [makeBufferLine('/root/workspace/myrepo/README.md:5:3')],
      new Map(),
      { worktreePath, wslDistro: 'Ubuntu', startupCwd: '/root/workspace/myrepo' }
    )

    const links = await new Promise<ILink[]>((resolve) => {
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    })

    expect(links).toHaveLength(1)
    expect(window.api.shell.pathExists).toHaveBeenCalledWith(mappedPath)
    links[0]!.hover?.({} as MouseEvent, links[0]!.text)
    expect(linkTooltip.textContent).toContain(mappedPath)
    links[0]!.activate?.(
      { ctrlKey: true, metaKey: false, shiftKey: false } as MouseEvent,
      links[0]!.text
    )
    await flushAsyncWork()
    await flushDoubleRaf()

    expect(statMock).toHaveBeenCalledWith({ filePath: mappedPath })
    expect(openFileMock).toHaveBeenCalledWith(expect.objectContaining({ filePath: mappedPath }), {
      forceContentReload: true
    })
    expect(setPendingEditorRevealMock).toHaveBeenLastCalledWith({
      filePath: mappedPath,
      fileId: mappedPath,
      line: 5,
      column: 3,
      matchLength: 0
    })
  })

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

  it('canonicalizes WSL UNC to the Windows backslash form', () => {
    expect(
      mapTerminalFilePath('//wsl.localhost/Ubuntu/root/file.md', '\\\\wsl.localhost\\Ubuntu\\repo')
    ).toBe('\\\\wsl.localhost\\Ubuntu\\root\\file.md')
    expect(
      mapTerminalFilePath(
        '\\\\wsl.localhost\\Ubuntu\\root\\file.md',
        '\\\\wsl.localhost\\Ubuntu\\repo'
      )
    ).toBe('\\\\wsl.localhost\\Ubuntu\\root\\file.md')
    expect(
      mapTerminalFilePath('\\\\server\\share\\file.md', '\\\\wsl.localhost\\Ubuntu\\repo')
    ).toBe('\\\\server\\share\\file.md')
    expect(mapTerminalFilePath('//server/share/file.md', '\\\\wsl.localhost\\Ubuntu\\repo')).toBe(
      '//server/share/file.md'
    )
    expect(mapTerminalFilePath('C:/repo/file.md', '\\\\wsl.localhost\\Ubuntu\\repo')).toBe(
      'C:/repo/file.md'
    )
  })

  it('does not map POSIX paths for a native Windows worktree', () => {
    expect(mapTerminalFilePath('/repo/file.md', 'C:\\repo')).toBe('/repo/file.md')
    expect(mapTerminalFilePath('/mnt/c/repo/file.md', '/Users/a/repo')).toBe('/mnt/c/repo/file.md')
  })

  it('keeps WSL-looking paths literal without a local WSL owner', () => {
    expect(mapTerminalFilePath('//wsl.localhost/Ubuntu/repo/file.md', '/remote/repo')).toBe(
      '//wsl.localhost/Ubuntu/repo/file.md'
    )
    expect(
      mapTerminalFilePath(
        '//wsl.localhost/Ubuntu/repo/file.md',
        '\\\\wsl.localhost\\Ubuntu\\repo',
        null
      )
    ).toBe('//wsl.localhost/Ubuntu/repo/file.md')
  })

  it('maps POSIX paths with the pane WSL distro when the worktree is on a Windows drive', () => {
    expect(mapTerminalFilePath('/home/alice/notes.md', 'C:\\repo', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\alice\\notes.md'
    )
    expect(mapTerminalFilePath('/mnt/c/repo/README.md', 'C:\\repo', 'Ubuntu')).toBe(
      'C:\\repo\\README.md'
    )
  })

  it('routes /mnt drive paths to the native Windows drive for a WSL worktree', () => {
    expect(mapTerminalFilePath('/mnt/c/repo/README.md', '\\\\wsl.localhost\\Ubuntu\\repo')).toBe(
      'C:\\repo\\README.md'
    )
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

  it('ignores the pane WSL distro for remote runtime panes', async () => {
    setPlatform('Windows')
    storeState.settings = { activeRuntimeEnvironmentId: 'env-2' }

    openDetectedFilePath('/home/alice/notes.md', null, null, {
      worktreeId: 'wt-1',
      worktreePath: 'C:\\repo',
      wslDistro: 'Ubuntu',
      runtimeEnvironmentId: 'env-1'
    })
    await flushAsyncWork()

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({
      targetPath: '/home/alice/notes.md'
    })
  })
})
