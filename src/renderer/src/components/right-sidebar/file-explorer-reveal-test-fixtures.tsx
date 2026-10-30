import type * as Module0 from './file-explorer-dir-load-tracker'
import type * as Module1 from './file-explorer-directory-listing'
import type * as Module2 from './file-explorer-operation-owner'
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi, type Mock } from 'vitest'
import { useAppStore } from '@/store'
import {
  noteUserWorkspaceSwitch,
  resetWorkspaceSwitchUserActsForTests
} from '@/lib/workspace-switch-user-act'
import type { FileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'
import type { TreeNode } from './file-explorer-types'
import {
  initializeExplorerSubscriptions,
  listing as runtimeListing
} from './file-explorer-lifecycle-test-support'

const trackers = vi.hoisted(() => Array<FileExplorerDirLoadTracker>())
vi.mock('./file-explorer-dir-load-tracker', async (original) => {
  const actual = await original<typeof Module0>()
  return {
    ...actual,
    createFileExplorerDirLoadTracker: (
      ...args: Parameters<typeof actual.createFileExplorerDirLoadTracker>
    ) => {
      const tracker = actual.createFileExplorerDirLoadTracker(...args)
      trackers.push(tracker)
      return tracker
    }
  }
})
const read: Mock<typeof Module1.readFileExplorerDirectory> = vi.hoisted(() =>
  vi.fn<typeof Module1.readFileExplorerDirectory>()
)
const owner = vi.hoisted(() => ({ kind: 'local' as const }))
export const listing = (...names: string[]) => ({
  ...runtimeListing(...names),
  operationOwner: owner
})
vi.mock('./file-explorer-directory-listing', async (original) => ({
  ...(await original<typeof Module1>()),
  readFileExplorerDirectory: read
}))
vi.mock('./file-explorer-operation-owner', async (original) => ({
  ...(await original<typeof Module2>()),
  getFileExplorerOperationOwner: () => owner,
  getFileExplorerOperationOwnerFromState: () => owner
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => async () => true
}))
vi.mock('./FileExplorerRow', () => ({
  FileExplorerRow: ({ node, isFlashing }: { node: TreeNode; isFlashing: boolean }) => (
    <button data-path={node.path} data-flashing={isFlashing}>
      {node.name}
    </button>
  )
}))
export const initial = useAppStore.getInitialState()
export const rootListing = () => ({
  ...listing(),
  entries: [{ name: 'a', isDirectory: true, isSymlink: false }]
})
export const deliverRevealScroll = async () => {
  act(() => vi.advanceTimersToNextFrame())
  await act(async () => {
    // A zero-delay timeout created inside the frame runs on the next clock turn.
    await vi.advanceTimersByTimeAsync(1)
  })
}
export const settle = () =>
  act(async () => {
    await vi.runAllTimersAsync()
  })
beforeEach(() => {
  resetWorkspaceSwitchUserActsForTests()
  noteUserWorkspaceSwitch('wt')
  trackers.length = 0
  vi.useFakeTimers()
  initializeExplorerSubscriptions()
  useAppStore.setState(initial, true)
  useAppStore.setState({
    activeWorktreeId: 'wt',
    expandedDirs: {},
    openFiles: [
      {
        id: 'target',
        filePath: '/repo/a/target.txt',
        relativePath: 'a/target.txt',
        worktreeId: 'wt',
        mode: 'edit',
        language: 'text',
        isDirty: false
      }
    ],
    activeFileId: null
  })
  read
    .mockReset()
    .mockImplementation((_id, _root, path) =>
      Promise.resolve(path === '/repo' ? rootListing() : listing('old.txt'))
    )
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

export { trackers, read, owner }
