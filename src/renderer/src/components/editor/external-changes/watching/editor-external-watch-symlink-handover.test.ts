// A folder watch released to a successor still routes main's late payloads for it, and asks main for what it had queued.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { FsChangedPayload } from '../../../../../../shared/file-watch/filesystem-change-event'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import {
  localWatchRoot,
  watchRootStatus,
  type HeldWatchRoots
} from './editor-external-watch-local-roots'
import { SymlinkedTabFolderWatches } from './editor-external-watch-symlink-folders'
import { selectLocalTabFoldersKey } from './editor-external-watch-tab-folders-key'

const OUTER = '/ws/linked/a'
const INNER = '/ws/linked/a/b'
const target: EditorExternalWatchTarget = {
  worktreeId: 'wt',
  worktreePath: '/ws',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

/** What main still held for this window on the inner watch when it was released. */
const queued: FsChangedPayload = {
  worktreePath: INNER,
  events: [{ kind: 'update', absolutePath: `${INNER}/file.md` }]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    api: {
      fs: {
        findSymlinkBelowRoot: async () => '/ws/linked',
        watchWorktree: async () => 'watching',
        // Why: main hands back only to a caller that asks for it.
        unwatchWorktree: async (args: { worktreePath: string; handOver?: boolean }) =>
          args.handOver === true && args.worktreePath === INNER ? queued : undefined
      }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function tabsIn(folders: string[]): string {
  const files: AppState['openFiles'] = folders.map((folder, index) => ({
    id: `tab-${index}`,
    worktreeId: target.worktreeId,
    filePath: `${folder}/file.md`,
    relativePath: `${folder.slice(target.worktreePath.length + 1)}/file.md`,
    language: 'markdown',
    isDirty: false,
    mode: 'edit'
  }))
  return selectLocalTabFoldersKey(files, [target])
}

it('routes what the released inner watch had queued, and its late payloads, to the inner folder', async () => {
  const handedBack: FsChangedPayload[] = []
  const folders = new SymlinkedTabFolderWatches(() => {})
  folders.routeHandOversTo((payload) => handedBack.push(payload))
  const held: HeldWatchRoots = new Map()
  folders.sync(tabsIn([INNER]), [target], held)
  await vi.advanceTimersByTimeAsync(0)

  folders.sync(tabsIn([OUTER, INNER]), [target], held)
  await vi.advanceTimersByTimeAsync(0)
  expect(watchRootStatus(held, localWatchRoot(INNER))).toBeUndefined()
  expect(handedBack).toEqual([queued])
  // Why after the reply: main's last flush for the watch travels on another pipe and can land after it.
  expect(folders.targetsFor(INNER, undefined, held)).toEqual([target])
  folders.clear()
})
