import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    runtimeEnvironments: [
      {
        id: 'wsl:Ubuntu',
        orcadDeployment: {
          kind: 'wsl' as const,
          distro: 'Ubuntu',
          localPort: 4100,
          remotePort: 4200
        }
      },
      { id: 'paired-server' }
    ]
  },
  openInFileManager: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

import { isLocalPathOpenBlocked, isRevealOrEditorOpenBlocked } from './local-path-open-guard'
import { getExternalEditorOpenCapability } from './external-editor-open-capability'
import { revealInFileManager } from './reveal-in-file-manager'
import {
  getWindowsPathAccess,
  listWslHostWindowsPathAccess,
  registerWindowsPathAccessEnvironments
} from './windows-path-access'

const WSL_OWNER = 'runtime:wsl%3AUbuntu'
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'

beforeEach(() => {
  registerWindowsPathAccessEnvironments(() => mocks.state.runtimeEnvironments)
  vi.stubGlobal('navigator', { userAgent: WINDOWS_UA })
  vi.stubGlobal('window', { api: { shell: { openInFileManager: mocks.openInFileManager } } })
  mocks.openInFileManager.mockResolvedValue({ ok: true })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('getWindowsPathAccess (renderer)', () => {
  it('resolves the owner WSL host from the known environments', () => {
    expect(getWindowsPathAccess(WSL_OWNER)?.toWindows('/home/me')).toBe(
      '\\\\wsl.localhost\\Ubuntu\\home\\me'
    )
    expect(getWindowsPathAccess('runtime:paired-server')).toBeNull()
    expect(getWindowsPathAccess('local')).toBeNull()
  })

  it('is null off Windows and in a web client', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Macintosh)' })
    expect(getWindowsPathAccess(WSL_OWNER)).toBeNull()
    vi.stubGlobal('navigator', { userAgent: WINDOWS_UA })
    vi.stubGlobal('window', { __ORCA_WEB_CLIENT__: true })
    expect(getWindowsPathAccess(WSL_OWNER)).toBeNull()
  })

  it('lists WSL hosts only while the experiment is on', () => {
    expect(
      listWslHostWindowsPathAccess(mocks.state.runtimeEnvironments, true).map(
        (host) => host.environmentId
      )
    ).toEqual(['wsl:Ubuntu'])
    expect(listWslHostWindowsPathAccess(mocks.state.runtimeEnvironments, false)).toEqual([])
  })
})

describe('reveal and open-in-editor guards', () => {
  it('unblock a WSL-owned path, but not system-default opens', () => {
    expect(isRevealOrEditorOpenBlocked(WSL_OWNER)).toBe(false)
    expect(isRevealOrEditorOpenBlocked({ kind: 'resolved', owner: WSL_OWNER })).toBe(false)
    expect(isLocalPathOpenBlocked(WSL_OWNER)).toBe(true)
  })

  it('stay blocked for SSH, paired servers and unplaced owners', () => {
    for (const owner of ['ssh:box', 'runtime:paired-server', 'unresolved'] as const) {
      expect(isRevealOrEditorOpenBlocked(owner)).toBe(true)
    }
    expect(isRevealOrEditorOpenBlocked({ kind: 'missing' })).toBe(true)
    expect(isRevealOrEditorOpenBlocked('local')).toBe(false)
  })

  it('stay blocked for a WSL host off Windows', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })
    expect(isRevealOrEditorOpenBlocked(WSL_OWNER)).toBe(true)
  })

  it('allow any external editor for a WSL owner and mark it', () => {
    for (const command of ['code', 'cursor', 'zed']) {
      expect(
        getExternalEditorOpenCapability({ command, runtimeEnvironmentId: 'wsl:Ubuntu' })
      ).toEqual({ allowed: true, remote: false, wsl: true })
    }
    expect(
      getExternalEditorOpenCapability({ command: 'code', runtimeEnvironmentId: 'paired-server' })
    ).toEqual({ allowed: false, reason: 'remote-runtime' })
    expect(
      getExternalEditorOpenCapability({
        command: 'code',
        runtimeEnvironmentId: 'wsl:Ubuntu',
        ownerUnresolved: true
      })
    ).toEqual({ allowed: false, reason: 'remote-runtime' })
  })

  it('hand main the owner, so main translates the Linux path itself', async () => {
    await revealInFileManager('/home/me/repo', WSL_OWNER)
    expect(mocks.openInFileManager).toHaveBeenCalledWith('/home/me/repo', WSL_OWNER)
  })
})
