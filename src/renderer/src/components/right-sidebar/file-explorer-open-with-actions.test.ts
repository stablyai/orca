import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mergeOpenWithMenuEntries,
  openPathWithApplication,
  openPathWithPreferredApplication,
  pickAndRegisterOpenWithApplication,
  toggleOpenWithDefault
} from './file-explorer-open-with-actions'
import type { OpenWithApplication } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  toastError: vi.fn(),
  updateSettings: vi.fn().mockResolvedValue(undefined),
  openInExternalEditor: vi.fn(),
  openFilePath: vi.fn(),
  pickApplication: vi.fn()
}))

vi.mock('@/store', () => ({ useAppStore: { getState: mocks.getState } }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => options?.[name] ?? '')
}))

const preview: OpenWithApplication = {
  id: 'app-preview',
  label: 'Preview',
  command: `open -a '/Applications/Preview.app'`,
  applicationPath: '/Applications/Preview.app'
}

function stateWith(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    settings: {
      activeRuntimeEnvironmentId: null,
      openWithApplications: [preview],
      openWithDefaults: { '.png': 'app-preview' }
    },
    repos: [{ id: 'repo-1', connectionId: null }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    activeWorktreeId: 'wt-1',
    updateSettings: mocks.updateSettings,
    ...overrides
  }
}

beforeEach(() => {
  mocks.getState.mockReset().mockReturnValue(stateWith())
  mocks.toastError.mockReset()
  mocks.updateSettings.mockReset().mockResolvedValue(undefined)
  mocks.openInExternalEditor.mockReset().mockResolvedValue({ ok: true })
  mocks.openFilePath.mockReset().mockResolvedValue(true)
  mocks.pickApplication.mockReset()
  ;(globalThis as unknown as { window: { api: unknown } }).window = {
    api: {
      shell: {
        openInExternalEditor: mocks.openInExternalEditor,
        openFilePath: mocks.openFilePath,
        pickApplication: mocks.pickApplication
      }
    }
  }
})

describe('openPathWithPreferredApplication', () => {
  it('uses the pinned app for a type that has a rule', async () => {
    await openPathWithPreferredApplication('/repo/a.png')

    expect(mocks.openInExternalEditor).toHaveBeenCalledWith({
      path: '/repo/a.png',
      command: preview.command,
      connectionId: null
    })
    expect(mocks.openFilePath).not.toHaveBeenCalled()
  })

  it('falls back to the OS association for an unpinned type', async () => {
    await openPathWithPreferredApplication('/repo/a.ts')

    expect(mocks.openFilePath).toHaveBeenCalledWith('/repo/a.ts')
    expect(mocks.openInExternalEditor).not.toHaveBeenCalled()
  })

  it('passes the SSH connection through instead of blocking', async () => {
    mocks.getState.mockReturnValue(stateWith({ repos: [{ id: 'repo-1', connectionId: 'ssh-1' }] }))

    await openPathWithPreferredApplication('/repo/a.png')

    expect(mocks.openInExternalEditor).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' })
    )
  })

  it('refuses a remote-runtime path that has no connection to launch through', async () => {
    mocks.getState.mockReturnValue(
      stateWith({
        settings: {
          activeRuntimeEnvironmentId: 'runtime-1',
          openWithApplications: [preview],
          openWithDefaults: { '.png': 'app-preview' }
        }
      })
    )

    await openPathWithPreferredApplication('/repo/a.png')

    expect(mocks.openInExternalEditor).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Opening remote paths in the local OS is not available.'
    )
  })
})

describe('openPathWithApplication', () => {
  it('refuses a remote-runtime path with no connection to launch through', async () => {
    mocks.getState.mockReturnValue(
      stateWith({
        settings: {
          activeRuntimeEnvironmentId: 'runtime-1',
          openWithApplications: [preview],
          openWithDefaults: {}
        }
      })
    )

    await openPathWithApplication('/repo/a.png', preview, null)

    expect(mocks.openInExternalEditor).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Opening remote paths in the local OS is not available.'
    )
  })

  it('still launches on a remote runtime when an SSH connection is given', async () => {
    mocks.getState.mockReturnValue(
      stateWith({
        settings: {
          activeRuntimeEnvironmentId: 'runtime-1',
          openWithApplications: [preview],
          openWithDefaults: {}
        }
      })
    )

    await openPathWithApplication('/repo/a.png', preview, 'ssh-1')

    expect(mocks.openInExternalEditor).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-1' })
    )
  })

  it('names the app when the launch fails', async () => {
    mocks.openInExternalEditor.mockResolvedValue({ ok: false, reason: 'launch-failed' })

    await openPathWithApplication('/repo/a.png', preview, null)

    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't open the file with Preview.")
  })
})

describe('pickAndRegisterOpenWithApplication', () => {
  it('returns null and writes nothing when the picker is canceled', async () => {
    mocks.pickApplication.mockResolvedValue(null)

    expect(await pickAndRegisterOpenWithApplication()).toBeNull()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })

  it('reuses the stored id when the same bundle is picked again', async () => {
    mocks.pickApplication.mockResolvedValue({
      applicationPath: preview.applicationPath,
      command: preview.command,
      label: 'Preview'
    })

    const application = await pickAndRegisterOpenWithApplication()

    expect(application?.id).toBe('app-preview')
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      openWithApplications: [expect.objectContaining({ id: 'app-preview' })]
    })
  })
})

describe('toggleOpenWithDefault', () => {
  it('clears the rule when the app is already the default', async () => {
    expect(await toggleOpenWithDefault('/repo/a.png', preview)).toBeNull()
    expect(mocks.updateSettings).toHaveBeenCalledWith({ openWithDefaults: {} })
  })

  it('pins a different registered app without re-adding it', async () => {
    const typora: OpenWithApplication = {
      id: 'app-typora',
      label: 'Typora',
      command: `open -a '/Applications/Typora.app'`,
      applicationPath: '/Applications/Typora.app'
    }
    mocks.getState.mockReturnValue(
      stateWith({
        settings: {
          activeRuntimeEnvironmentId: null,
          openWithApplications: [preview, typora],
          openWithDefaults: { '.png': 'app-preview' }
        }
      })
    )

    expect(await toggleOpenWithDefault('/repo/a.png', typora)).toBe('app-typora')
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      openWithApplications: [preview, typora],
      openWithDefaults: { '.png': 'app-typora' }
    })
  })

  it('adopts a workspace Open in editor so the rule can actually resolve', async () => {
    const vscode: OpenWithApplication = {
      id: 'vscode',
      label: 'VS Code',
      command: 'code',
      applicationPath: ''
    }

    expect(await toggleOpenWithDefault('/repo/a.ts', vscode)).toBe('vscode')
    expect(mocks.updateSettings).toHaveBeenCalledWith({
      openWithApplications: [preview, vscode],
      openWithDefaults: { '.png': 'app-preview', '.ts': 'vscode' }
    })
  })

  it('does nothing for an entry with no extension', async () => {
    expect(await toggleOpenWithDefault('/repo/Makefile', preview)).toBeNull()
    expect(mocks.updateSettings).not.toHaveBeenCalled()
  })
})

describe('mergeOpenWithMenuEntries', () => {
  it('lists registered picks first and appends unregistered Open in editors', () => {
    const merged = mergeOpenWithMenuEntries(
      [preview],
      [
        { id: 'vscode', label: 'VS Code', command: 'code' },
        { id: 'preview-cli', label: 'Preview (duplicate)', command: preview.command }
      ]
    )

    expect(merged.map((entry) => entry.label)).toEqual(['Preview', 'VS Code'])
    expect(merged[1].applicationPath).toBe('')
  })
})
