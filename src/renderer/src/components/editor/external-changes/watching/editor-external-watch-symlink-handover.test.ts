// A watch released to a successor keeps routing until main confirms the unwatch, then routes what main handed back.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { FsChangedPayload } from '../../../../../../shared/file-watch/filesystem-change-event'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import type { HeldWatchRoots } from './editor-external-watch-local-roots'
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

let finishUnwatch: ((payload: FsChangedPayload | undefined) => void) | undefined
let unwatchArgs: unknown[] = []

beforeEach(() => {
  finishUnwatch = undefined
  unwatchArgs = []
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    api: {
      fs: {
        findSymlinkBelowRoot: async () => '/ws/linked',
        watchWorktree: async () => 'watching',
        unwatchWorktree: (args: unknown) => {
          unwatchArgs.push(args)
          return new Promise((resolve) => {
            finishUnwatch = resolve
          })
        }
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
  expect(unwatchArgs).toEqual([{ worktreePath: INNER, connectionId: undefined, handOver: true }])
  const payload: FsChangedPayload = {
    worktreePath: INNER,
    events: [{ kind: 'update', absolutePath: `${INNER}/file.md` }]
  }
  finishUnwatch?.(payload)
  await vi.advanceTimersByTimeAsync(0)
  expect(handedBack).toEqual([payload])
  // Why after the reply: main's last flush for the watch travels on another pipe and can land after it.
  expect(folders.targetsFor(INNER, undefined, held)).toEqual([target])
  folders.clear()
})
