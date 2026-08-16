import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import {
  canOpenWorkspaceContextPath,
  openWorkspaceContextPath,
  workspaceContextAccessPath
} from './workspace-context-open'

const wslTarget = {
  kind: 'wsl' as const,
  distro: 'Ubuntu',
  homeDir: '/home/u',
  cwd: '/home/u/repo'
}

describe('workspace-context-open', () => {
  it('opens WSL report paths through the UNC mount, native ones as they are', () => {
    expect(workspaceContextAccessPath('/home/u/.claude.json', wslTarget)).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\u\\.claude.json'
    )
    expect(workspaceContextAccessPath('/mnt/c/src/AGENTS.md', wslTarget)).toBe('C:\\src\\AGENTS.md')
    expect(
      workspaceContextAccessPath('/home/u/x', {
        kind: 'native-host',
        homeDir: '/home/u',
        cwd: null
      })
    ).toBe('/home/u/x')
  })

  it('always allows worktree files and gates the rest on the external-open permission', () => {
    const inside = { displayPath: '/home/u/repo/CLAUDE.md', reportTarget: wslTarget }
    const outside = { displayPath: '/home/u/.claude/CLAUDE.md', reportTarget: wslTarget }
    expect(canOpenWorkspaceContextPath({ ...inside, allowAbsolutePaths: false })).toBe(true)
    expect(canOpenWorkspaceContextPath({ ...outside, allowAbsolutePaths: false })).toBe(false)
    expect(canOpenWorkspaceContextPath({ ...outside, allowAbsolutePaths: true })).toBe(true)
  })

  it('opens a WSL worktree file by its worktree-relative path and a home file as an authorized external', async () => {
    const openFile = vi.fn()
    const authorizeExternalPath = vi.fn(async () => {})
    const worktree = { id: 'wt', path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\repo' }
    await openWorkspaceContextPath({
      displayPath: '/home/u/repo/.mcp.json',
      reportTarget: wslTarget,
      worktree,
      allowAbsolutePaths: true,
      authorizeExternalPath,
      openFile
    })
    expect(authorizeExternalPath).not.toHaveBeenCalled()
    expect(openFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ relativePath: '.mcp.json', worktreeId: 'wt' })
    )
    await openWorkspaceContextPath({
      displayPath: '/home/u/.codex/config.toml',
      reportTarget: wslTarget,
      worktree,
      allowAbsolutePaths: true,
      authorizeExternalPath,
      openFile
    })
    const unc = '\\\\wsl.localhost\\Ubuntu\\home\\u\\.codex\\config.toml'
    expect(authorizeExternalPath).toHaveBeenCalledWith({ targetPath: unc })
    expect(openFile).toHaveBeenLastCalledWith(
      expect.objectContaining({ filePath: unc, relativePath: unc, runtimeEnvironmentId: null }),
      expect.objectContaining({ suppressActiveRuntimeFallback: true })
    )
  })

  it('does nothing for an external path when the workspace is not local', async () => {
    const openFile = vi.fn()
    await openWorkspaceContextPath({
      displayPath: '/home/u/.claude.json',
      reportTarget: wslTarget,
      worktree: { id: 'wt', path: '/home/u/repo' },
      allowAbsolutePaths: false,
      authorizeExternalPath: vi.fn(async () => {}),
      openFile
    })
    expect(openFile).not.toHaveBeenCalled()
  })
})
