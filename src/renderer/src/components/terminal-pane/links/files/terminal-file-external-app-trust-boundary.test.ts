// @orca-isolated-worker: the store double cannot be undone by the shared worker's reset.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = vi.hoisted(() => {
  const settings: { externalAppFileTypes: string[] } = { externalAppFileTypes: [] }
  return {
    settings,
    activeWorktreeId: null,
    repos: [{ id: 'repo-1', path: '/repo', connectionId: '' }],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    openFiles: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    openFileForLink: vi.fn(() => ({ fileId: 'f', viewStateId: 'v', groupId: 'g' })),
    setPendingEditorReveal: vi.fn(),
    setMarkdownViewMode: vi.fn(),
    updateSettings: vi.fn()
  }
})

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

import { openDetectedFilePath } from './terminal-file-open-routing'

const openFilePath = vi.fn()
const stat = vi.fn()

const deps = { worktreeId: 'repo-1::/repo', worktreePath: '/repo' }

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.settings.externalAppFileTypes = []
  storeState.repos = [{ id: 'repo-1', path: '/repo', connectionId: '' }]
  openFilePath.mockResolvedValue(true)
  stat.mockResolvedValue({ size: 10, isDirectory: false, mtime: 1 })
  vi.stubGlobal('window', {
    api: {
      shell: { openFilePath },
      fs: { stat, downloadFile: vi.fn() }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// Terminal and chat text is untrusted: only Shift, a menu choice, or the user's remembered opt-in
// may hand a file to an external OS parser (a .blend can carry embedded Python).
describe('untrusted file links keep the external-app trust boundary', () => {
  it('opens a plain click on a creative project file in Orca, never the OS', async () => {
    openDetectedFilePath('/repo/scene.blend', null, null, deps)
    await flushAsyncWork()
    expect(openFilePath).not.toHaveBeenCalled()
    expect(storeState.openFileForLink).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: '/repo/scene.blend' }),
      expect.anything(),
      null,
      expect.any(Function)
    )
  })

  it('hands the file to the OS on Shift+click', async () => {
    openDetectedFilePath('/repo/scene.blend', null, null, {
      ...deps,
      openWithSystemDefault: true
    })
    await flushAsyncWork()
    expect(openFilePath).toHaveBeenCalledWith('/repo/scene.blend', 'local', undefined)
    expect(storeState.openFileForLink).not.toHaveBeenCalled()
  })

  it('routes a plain click externally only for a file type the user opted into', async () => {
    storeState.settings.externalAppFileTypes = ['blend']
    openDetectedFilePath('/repo/other.psd', null, null, deps)
    await flushAsyncWork()
    expect(openFilePath).not.toHaveBeenCalled()

    openDetectedFilePath('/repo/Scene.BLEND', null, null, deps)
    await flushAsyncWork()
    expect(openFilePath).toHaveBeenCalledWith('/repo/Scene.BLEND', 'local', undefined)
  })

  it('never lets the remembered opt-in launch a file owned by an SSH host', async () => {
    storeState.settings.externalAppFileTypes = ['blend']
    storeState.repos = [{ id: 'repo-1', path: '/repo', connectionId: 'render-host' }]
    openDetectedFilePath('/repo/scene.blend', null, null, deps)
    await flushAsyncWork()
    expect(openFilePath).not.toHaveBeenCalled()
    expect(window.api.fs.downloadFile).not.toHaveBeenCalled()
  })
})
