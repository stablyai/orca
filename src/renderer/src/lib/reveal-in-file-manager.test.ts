import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getRevealInFileManagerLabel,
  isRevealInFileManagerBlocked,
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

describe('isRevealInFileManagerBlocked', () => {
  const local = { activeRuntimeEnvironmentId: null }

  it('allows a file this client owns', () => {
    expect(isRevealInFileManagerBlocked(local, {})).toBe(false)
    expect(isRevealInFileManagerBlocked(null, { connectionId: null })).toBe(false)
    expect(isRevealInFileManagerBlocked(local, { runtimeEnvironmentId: null })).toBe(false)
  })

  it('blocks a file on an SSH host', () => {
    expect(isRevealInFileManagerBlocked(local, { connectionId: 'ssh-1' })).toBe(true)
  })

  it('blocks a runtime-owned file even after the focused runtime switches to local', () => {
    expect(isRevealInFileManagerBlocked(local, { runtimeEnvironmentId: 'env-1' })).toBe(true)
  })

  it('allows a file this client owns while a remote runtime is focused', () => {
    expect(
      isRevealInFileManagerBlocked(
        { activeRuntimeEnvironmentId: 'env-1' },
        { runtimeEnvironmentId: null }
      )
    ).toBe(false)
  })

  it('falls back to the focused runtime when the owner is omitted, as the main process does', () => {
    expect(isRevealInFileManagerBlocked({ activeRuntimeEnvironmentId: 'env-1' }, {})).toBe(true)
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

    await revealInFileManager('/repo/src/foo.ts', null)

    expect(openInFileManager).toHaveBeenCalledWith('/repo/src/foo.ts', null)
    expect(toastError).not.toHaveBeenCalled()
  })

  it('says the file is gone when it no longer exists', async () => {
    openInFileManager.mockResolvedValue({ ok: false, reason: 'not-found' })

    await revealInFileManager('/repo/src/deleted.ts')

    expect(toastError).toHaveBeenCalledWith('File not found. It may have been moved or deleted.')
  })

  it('says remote paths cannot be revealed when a remote runtime is focused', async () => {
    openInFileManager.mockResolvedValue({ ok: false, reason: 'remote-runtime-unsupported' })

    await revealInFileManager('/repo/src/foo.ts')

    expect(toastError).toHaveBeenCalledWith(
      'Opening remote paths in the local OS is not available.'
    )
  })

  it('reports a file manager that failed to launch', async () => {
    openInFileManager.mockResolvedValue({ ok: false, reason: 'launch-failed' })

    await revealInFileManager('/repo/src/foo.ts')

    expect(toastError).toHaveBeenCalledWith('Could not reveal the file.')
  })
})
