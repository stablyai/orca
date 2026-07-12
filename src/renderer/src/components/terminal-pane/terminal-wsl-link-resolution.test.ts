import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getPaneWslRuntimeDistro,
  resolveWslLinkAbsolutePath,
  wslLinkPathExists
} from './terminal-wsl-link-resolution'

const wslPathExistsMock = vi.fn()
const wslWorktreePath = '\\\\wsl.localhost\\Ubuntu\\home\\j\\app'
const storeState = {
  repos: [] as { id: string; path: string; displayName: string }[],
  worktreesByRepo: {} as Record<
    string,
    { id: string; path: string; repoId?: string; projectId?: string }[]
  >,
  projects: [] as { id: string; displayName: string }[],
  settings: undefined
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

beforeEach(() => {
  wslPathExistsMock.mockReset()
  storeState.repos = []
  storeState.worktreesByRepo = {}
  storeState.projects = []
  // Why: getPaneWslRuntimeDistro gates on the Windows app platform (WSL is
  // Windows-only) via navigator.userAgent when window.api.platform is absent.
  vi.stubGlobal('navigator', { userAgent: 'Windows' })
  vi.stubGlobal('window', { api: { wsl: { pathExists: wslPathExistsMock } } })
})

describe('getPaneWslRuntimeDistro', () => {
  it('returns the distro for a WSL-native worktree', () => {
    storeState.repos = [{ id: 'repo-1', path: wslWorktreePath, displayName: 'app' }]
    storeState.worktreesByRepo = {
      'repo-1': [{ id: 'wt-1', path: wslWorktreePath, repoId: 'repo-1', projectId: 'repo-1' }]
    }

    expect(getPaneWslRuntimeDistro('wt-1')).toBe('Ubuntu')
  })

  it('returns null for a non-WSL worktree', () => {
    expect(getPaneWslRuntimeDistro('wt-1')).toBeNull()
  })
})

describe('resolveWslLinkAbsolutePath', () => {
  it('maps a POSIX path onto the distro UNC share', () => {
    expect(resolveWslLinkAbsolutePath('/home/j/app/src/x.ts', 'Ubuntu')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\j\\app\\src\\x.ts'
    )
  })

  it('returns null without a distro', () => {
    expect(resolveWslLinkAbsolutePath('/home/j/app/src/x.ts', null)).toBeNull()
  })

  it('returns null for a non-POSIX path even with a distro', () => {
    expect(resolveWslLinkAbsolutePath('C:\\Users\\j\\app\\x.ts', 'Ubuntu')).toBeNull()
  })
})

describe('wslLinkPathExists', () => {
  it('treats a confirmed existing path as existing', async () => {
    wslPathExistsMock.mockResolvedValue(true)
    await expect(wslLinkPathExists('\\\\wsl.localhost\\Ubuntu\\home\\j\\app\\x.ts')).resolves.toBe(
      true
    )
  })

  it('treats a confirmed missing path as missing', async () => {
    wslPathExistsMock.mockResolvedValue(false)
    await expect(wslLinkPathExists('\\\\wsl.localhost\\Ubuntu\\home\\j\\missing.ts')).resolves.toBe(
      false
    )
  })

  it('treats an inconclusive (null) answer as existing', async () => {
    wslPathExistsMock.mockResolvedValue(null)
    await expect(wslLinkPathExists('\\\\wsl.localhost\\Ubuntu\\home\\j\\app\\x.ts')).resolves.toBe(
      true
    )
  })
})
