import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRevealInFileManagerLabel,
  getWorkspaceFileRevealOwner,
  revealInFileManager
} from './reveal-in-file-manager'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

describe('getRevealInFileManagerLabel', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'Reveal in Finder'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Reveal in File Explorer'],
    ['Mozilla/5.0 (X11; Linux x86_64)', 'Open Containing Folder']
  ])('names the file manager for %s', (userAgent, label) => {
    vi.stubGlobal('navigator', { userAgent })

    expect(getRevealInFileManagerLabel()).toBe(label)
  })
})

describe('getWorkspaceFileRevealOwner', () => {
  // A focused server must not decide where a file lives.
  const state = {
    settings: { activeRuntimeEnvironmentId: 'env-focused' },
    worktreesByRepo: {
      'repo-1': [{ id: 'repo-1::/repo', repoId: 'repo-1', hostId: 'local' as const }]
    }
  }

  it('returns local for a local workspace file even while a server is focused', () => {
    expect(getWorkspaceFileRevealOwner(state, 'repo-1::/repo', {})).toBe('local')
  })

  it('names the SSH host or server from the route', () => {
    expect(getWorkspaceFileRevealOwner(state, 'repo-1::/repo', { connectionId: 'ssh-1' })).toBe(
      'ssh:ssh-1'
    )
    expect(
      getWorkspaceFileRevealOwner(state, 'repo-1::/repo', { runtimeEnvironmentId: 'env-1' })
    ).toBe('runtime:env-1')
  })

  it('refuses a route that reads local when the catalog cannot place the workspace', () => {
    expect(getWorkspaceFileRevealOwner(state, 'repo-missing::/elsewhere', {})).toBe('unresolved')
  })
})

describe('revealInFileManager', () => {
  const openInFileManager = vi.fn()

  beforeEach(() => {
    toastError.mockReset()
    openInFileManager.mockReset()
    vi.stubGlobal('window', { api: { shell: { openInFileManager } } })
  })

  afterEach(() => vi.unstubAllGlobals())

  it('reveals the path without a toast when the OS accepts it', async () => {
    openInFileManager.mockResolvedValue({ ok: true })

    await revealInFileManager('/repo/src/foo.ts', 'local')

    expect(openInFileManager).toHaveBeenCalledWith('/repo/src/foo.ts', 'local')
    expect(toastError).not.toHaveBeenCalled()
  })

  it.each(['ssh:ssh-1', 'runtime:env-1', 'unresolved'] as const)(
    'refuses a path owned by %s without asking the OS',
    async (owner) => {
      await revealInFileManager('/repo/src/foo.ts', owner)

      expect(openInFileManager).not.toHaveBeenCalled()
      expect(toastError).toHaveBeenCalledWith(
        'Opening remote paths in the local OS is not available.'
      )
    }
  )

  it('says the file is gone when it no longer exists', async () => {
    openInFileManager.mockResolvedValue({ ok: false, reason: 'not-found' })

    await revealInFileManager('/repo/src/deleted.ts', 'local')

    expect(toastError).toHaveBeenCalledWith('File not found. It may have been moved or deleted.')
  })

  it('says remote paths cannot be revealed when the main process refuses the owner', async () => {
    openInFileManager.mockResolvedValue({ ok: false, reason: 'remote-runtime-unsupported' })

    await revealInFileManager('/repo/src/foo.ts', 'local')

    expect(toastError).toHaveBeenCalledWith(
      'Opening remote paths in the local OS is not available.'
    )
  })

  it('reports a file manager that failed to launch', async () => {
    openInFileManager.mockResolvedValue({ ok: false, reason: 'launch-failed' })

    await revealInFileManager('/repo/src/foo.ts', 'local')

    expect(toastError).toHaveBeenCalledWith('Could not reveal the file.')
  })
})
