import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getConnectionId } from '@/lib/workspace/ownership/connection-context'

type StatArgs = { filePath: string; connectionId?: string }

const mocks = vi.hoisted(() => {
  const state: { value: Record<string, unknown> } = { value: {} }
  return {
    state,
    stat: vi.fn<
      (args: StatArgs) => Promise<{ isDirectory: boolean; size: number; mtime: number }>
    >(),
    openFilePath: vi.fn(),
    pathsExist: vi.fn(),
    activateAndRevealWorktree: vi.fn()
  }
})

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => mocks.state.value } }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree,
  activateAndRevealWorkspace: vi.fn()
}))
import { createNativeChatFileLinkExistence } from '../../../native-chat/links/actions/native-chat-file-link-existence'
import { extractTerminalFileLinks } from '../../../../../../shared/terminal/links/terminal-links'

const id = 'repo::/home/u/proj'

function sameIdState(activeHost: string | null): Record<string, unknown> {
  return {
    settings: { activeRuntimeEnvironmentId: null },
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: activeHost,
    repos: [
      { id: 'repo', executionHostId: 'local' },
      { id: 'repo', connectionId: 'box', executionHostId: 'ssh:box' },
      { id: 'desktop', executionHostId: 'local' }
    ],
    worktreesByRepo: {
      repo: [
        { id, repoId: 'repo', path: '/home/u/proj', hostId: 'local' },
        { id, repoId: 'repo', path: '/home/u/proj', hostId: 'ssh:box' }
      ],
      desktop: [
        {
          id: 'desktop::/tmp/desktop-root',
          repoId: 'desktop',
          path: '/tmp/desktop-root',
          hostId: 'local'
        }
      ]
    },
    folderWorkspaces: [],
    projectGroups: [],
    openFiles: [],
    activeFileIdByWorktree: {}
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.value = sameIdState('ssh:box')
  mocks.stat.mockResolvedValue({ isDirectory: true, size: 0, mtime: 0 })
  mocks.openFilePath.mockResolvedValue(true)
  mocks.pathsExist.mockImplementation(async (paths: string[]) => paths.map(() => true))
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  vi.stubGlobal('window', {
    api: {
      fs: { stat: mocks.stat },
      shell: { openFilePath: mocks.openFilePath, pathsExist: mocks.pathsExist }
    }
  })
})

describe('same-id SSH terminal file links', () => {
  it('stops a held native-chat link from rechecking the desktop once the owner turns ambiguous', async () => {
    const registeredLocal = {
      ...sameIdState('local'),
      activeWorktreeId: 'other',
      worktreesByRepo: { repo: [{ id, repoId: 'repo', path: '/home/u/proj', hostId: 'local' }] },
      detectedWorktreesByRepo: {}
    }
    mocks.state.value = registeredLocal
    const existence = createNativeChatFileLinkExistence({
      cwd: '/home/u/proj',
      worktreeId: id,
      worktreePath: '/home/u/proj',
      runtimeEnvironmentId: null,
      connectionId: getConnectionId(id)
    })
    const watcher = existence.watch()
    const unsubscribe = watcher.subscribe(() => {})
    watcher.getSnapshot().check(extractTerminalFileLinks('src/App.tsx')[0])
    await settle()
    expect(mocks.pathsExist).toHaveBeenCalledOnce()
    mocks.pathsExist.mockClear()

    // The same id is then detected on the SSH host; the chat's own context is unchanged.
    mocks.state.value = {
      ...registeredLocal,
      detectedWorktreesByRepo: {
        repo: { worktrees: [{ id, repoId: 'repo', path: '/home/u/proj', hostId: 'ssh:box' }] }
      }
    }
    expect(getConnectionId(id)).toBeNull()
    existence.recheck()
    await settle()
    unsubscribe()

    expect(mocks.pathsExist).not.toHaveBeenCalled()
  })
})
