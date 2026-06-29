/**
 * Reproduction harness for issue #6648:
 * "Remote host attempting to view a file results in error"
 *
 * On Windows, opening a file to edit it on a remote (SSH) host fails with:
 *   "Error invoking remote method 'fs:readFile': Error: Access denied: path
 *    resolves outside allowed directories."
 *
 * That message (PATH_ACCESS_DENIED_MESSAGE) is only produced by the LOCAL
 * filesystem resolver, which means the remote file path reached the local
 * read path WITHOUT a connectionId. This harness drives the real renderer
 * code paths to show how that happens and stays latched:
 *
 *   1. A connected SSH repo's connectionId is resolved from state.repos. While
 *      the SSH repo is still hydrating (e.g. right after a session restore on a
 *      slow Windows SSH connect), getConnectionId returns `undefined`.
 *   2. readRuntimeFileContent treats `undefined`/`null` connectionId identically
 *      and falls back to a LOCAL fs.readFile of the remote POSIX path.
 *   3. The local resolver denies the remote path -> PATH_ACCESS_DENIED_MESSAGE.
 *   4. The editor's retry gate refuses to retry "access denied", so the error
 *      latches permanently even after the SSH repo finishes hydrating.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/types'
import { useAppStore } from '@/store'
import { getConnectionIdForFile, isWorktreeConnectionResolved } from '@/lib/connection-context'
import {
  WORKTREE_OWNER_NOT_READY_ERROR,
  WORKTREE_OWNER_UNREACHABLE_ERROR
} from '@/components/editor/editor-panel-content-types'
import { shouldRetryFileLoadError } from '@/components/editor/useEditorPanelFileLoadRetry'
import { readRuntimeFileContent } from './runtime-file-client'

// Mirrors src/main/ipc/filesystem-auth.ts PATH_ACCESS_DENIED_MESSAGE.
const PATH_ACCESS_DENIED_MESSAGE =
  'Access denied: path resolves outside allowed directories. If this blocks a legitimate workflow, please file a GitHub issue.'

const REMOTE_REPO_ROOT = '/home/user/project'
const REMOTE_FILE_PATH = '/home/user/project/src/index.ts'
const SSH_TARGET_ID = 'ssh-target-1'
const SSH_REPO_ID = 'repo-ssh'
const REMOTE_WORKTREE_ID = `${SSH_REPO_ID}::${REMOTE_REPO_ROOT}`

const initialState = useAppStore.getInitialState()

const fsReadFile = vi.fn()

/**
 * Stand-in for the main-process `fs:readFile` IPC handler. It mirrors the real
 * routing in src/main/ipc/filesystem.ts: when a connectionId is supplied the
 * read is served by the SSH provider; otherwise it goes through the local
 * authorized-path resolver, which denies any path outside the local allowed
 * roots (SSH repo roots are intentionally excluded — see getLocalRepos).
 */
function mainProcessReadFile(args: { filePath: string; connectionId?: string }) {
  if (args.connectionId) {
    return Promise.resolve({ content: 'export const remote = true\n', isBinary: false })
  }
  // Local resolver: the remote POSIX path is not under any local allowed root.
  return Promise.reject(new Error(PATH_ACCESS_DENIED_MESSAGE))
}

function makeRepo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: REMOTE_REPO_ROOT,
    displayName: 'project',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

beforeEach(() => {
  fsReadFile.mockReset()
  fsReadFile.mockImplementation(mainProcessReadFile)
  vi.stubGlobal('window', {
    api: {
      fs: { readFile: fsReadFile },
      runtime: { call: vi.fn() },
      runtimeEnvironments: { call: vi.fn(), subscribe: vi.fn() }
    }
  })
})

afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.unstubAllGlobals()
})

// Replays the editor read path from useEditorPanelContentState.loadFileContent,
// including the owner-not-ready guard added for #6648.
async function openRemoteFileInEditor() {
  const resolvedConnectionId = getConnectionIdForFile(REMOTE_WORKTREE_ID, REMOTE_FILE_PATH)
  const connectionId = resolvedConnectionId ?? undefined
  const readSettings: { activeRuntimeEnvironmentId: string | null } = {
    activeRuntimeEnvironmentId: null
  }
  if (
    resolvedConnectionId === undefined &&
    !readSettings.activeRuntimeEnvironmentId?.trim() &&
    !isWorktreeConnectionResolved(REMOTE_WORKTREE_ID)
  ) {
    throw new Error(WORKTREE_OWNER_NOT_READY_ERROR)
  }
  return readRuntimeFileContent({
    settings: readSettings,
    filePath: REMOTE_FILE_PATH,
    relativePath: 'src/index.ts',
    worktreeId: REMOTE_WORKTREE_ID,
    connectionId
  })
}

describe('issue #6648: opening a remote-host file in the editor', () => {
  it('succeeds once the SSH repo is hydrated with its connectionId', async () => {
    useAppStore.setState({
      repos: [makeRepo({ id: SSH_REPO_ID, connectionId: SSH_TARGET_ID })],
      worktreesByRepo: {}
    })

    await expect(openRemoteFileInEditor()).resolves.toEqual({
      content: 'export const remote = true\n',
      isBinary: false
    })
    expect(fsReadFile).toHaveBeenCalledWith({
      filePath: REMOTE_FILE_PATH,
      connectionId: SSH_TARGET_ID
    })
  })

  it('FIXED: fails retryably (not a local access-denied) while the SSH repo hydrates', async () => {
    // Session restore reopened the remote tab, but the SSH repo has not landed
    // in state.repos yet (relay/connection still establishing — slower on
    // Windows). getConnectionIdForFile returns undefined for the unknown repo.
    useAppStore.setState({ repos: [], worktreesByRepo: {} })

    expect(getConnectionIdForFile(REMOTE_WORKTREE_ID, REMOTE_FILE_PATH)).toBeUndefined()
    expect(isWorktreeConnectionResolved(REMOTE_WORKTREE_ID)).toBe(false)

    // The owner-not-ready guard prevents the bad local read entirely.
    await expect(openRemoteFileInEditor()).rejects.toThrow(WORKTREE_OWNER_NOT_READY_ERROR)
    await expect(openRemoteFileInEditor()).rejects.not.toThrow(PATH_ACCESS_DENIED_MESSAGE)
    expect(fsReadFile).not.toHaveBeenCalled()
  })

  it('FIXED: recovers once the SSH repo finishes hydrating', async () => {
    useAppStore.setState({ repos: [], worktreesByRepo: {} })
    await expect(openRemoteFileInEditor()).rejects.toThrow(WORKTREE_OWNER_NOT_READY_ERROR)

    // Relay discovery completes and the SSH repo lands in the store.
    useAppStore.setState({
      repos: [makeRepo({ id: SSH_REPO_ID, connectionId: SSH_TARGET_ID })],
      worktreesByRepo: {}
    })

    await expect(openRemoteFileInEditor()).resolves.toEqual({
      content: 'export const remote = true\n',
      isBinary: false
    })
    expect(fsReadFile).toHaveBeenCalledWith({
      filePath: REMOTE_FILE_PATH,
      connectionId: SSH_TARGET_ID
    })
  })

  it('retry gate retries owner-not-ready but not access-denied or the terminal message', () => {
    // owner-not-ready auto-retries (while connecting)...
    expect(shouldRetryFileLoadError(WORKTREE_OWNER_NOT_READY_ERROR)).toBe(true)
    // ...but a genuine access-denied and the budget-exhausted terminal message
    // are NOT auto-retried (the terminal one only restarts via the Retry button).
    expect(shouldRetryFileLoadError(PATH_ACCESS_DENIED_MESSAGE)).toBe(false)
    expect(shouldRetryFileLoadError(WORKTREE_OWNER_UNREACHABLE_ERROR)).toBe(false)
  })
})
