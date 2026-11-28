// Guards STA-14938 (PR #49252), STA-18470 (PR #49343), STA-18506 and STA-18507 (PR #49466): open tab folders behind one symlink hold
// exactly the watch on their outermost open folder, across opening, closing and reopening that folder, and a watch is
// only released once a working successor sees every folder it saw.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { WatchWorktreeResult } from '../../../../../../shared/file-watch/watch-worktree-result'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import type * as localRoots from './editor-external-watch-local-roots'
import { refreshDeferredWatchRoot, type HeldWatchRoots } from './editor-external-watch-local-roots'

let statusReads = 0
vi.mock('./editor-external-watch-local-roots', async (importOriginal) => {
  const original = await importOriginal<typeof localRoots>()
  return {
    ...original,
    watchRootStatus: (...args: Parameters<typeof original.watchRootStatus>) => {
      statusReads += 1
      return original.watchRootStatus(...args)
    }
  }
})
import { SymlinkedTabFolderWatches } from './editor-external-watch-symlink-folders'
import { selectLocalTabFoldersKey } from './editor-external-watch-tab-folders-key'

const ROOT = '/ws'
const OUTER = '/ws/linked'
const LINKS = [OUTER, '/ws/linked/deep/inner']
const target: EditorExternalWatchTarget = {
  worktreeId: 'wt',
  worktreePath: ROOT,
  connectionId: undefined,
  runtimeEnvironmentId: null
}
/** A second workspace rooted at the link itself, so no link lies below its root. */
const linkedRoot: EditorExternalWatchTarget = {
  worktreeId: 'linked-root',
  worktreePath: OUTER,
  connectionId: undefined,
  runtimeEnvironmentId: null
}
const TARGETS = [target, linkedRoot]

let watched: string[] = []
let unwatched: string[] = []
let watchResults = new Map<string, WatchWorktreeResult>()
let slowProbes = new Set<string>()
let releaseSlowProbes: (() => void)[] = []
/** Watch requests main hasn't answered yet; unwatching one aborts it, as main does. */
let stalledInstalls: Map<string, () => void> | undefined

beforeEach(() => {
  watched = []
  unwatched = []
  watchResults = new Map()
  slowProbes = new Set()
  releaseSlowProbes = []
  stalledInstalls = undefined
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    api: {
      fs: {
        findSymlinkBelowRoot: async ({ rootPath, path }: { rootPath: string; path: string }) => {
          if (slowProbes.has(path)) {
            await new Promise<void>((resolve) => releaseSlowProbes.push(resolve))
          }
          if (rootPath === OUTER) {
            return null
          }
          return LINKS.findLast((link) => path === link || path.startsWith(`${link}/`)) ?? null
        },
        watchWorktree: async ({ worktreePath }: { worktreePath: string }) => {
          watched.push(worktreePath)
          if (stalledInstalls && worktreePath !== OUTER) {
            await new Promise<void>((resolve) => stalledInstalls?.set(worktreePath, resolve))
            return 'unavailable'
          }
          return watchResults.get(worktreePath) ?? 'watching'
        },
        unwatchWorktree: async ({ worktreePath }: { worktreePath: string }) => {
          unwatched.push(worktreePath)
          stalledInstalls?.get(worktreePath)?.()
        }
      }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function filesIn(folders: string[], owner: EditorExternalWatchTarget): AppState['openFiles'] {
  return folders.map((folder, index) => ({
    id: `${owner.worktreeId}-tab-${index}`,
    worktreeId: owner.worktreeId,
    filePath: `${folder}/file.md`,
    relativePath: `${folder.slice(owner.worktreePath.length + 1)}/file.md`,
    language: 'markdown',
    isDirty: false,
    mode: 'edit'
  }))
}

function tabsIn(folders: string[], others: AppState['openFiles'] = []): string {
  return selectLocalTabFoldersKey([...filesIn(folders, target), ...others], TARGETS)
}

/** Lets every probe and install answer, the slow probes last, and runs out any timer a handoff might wait on. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
  for (const release of releaseSlowProbes.splice(0)) {
    release()
  }
  await vi.advanceTimersByTimeAsync(60_000)
}

function heldPaths(held: HeldWatchRoots): string[] {
  return [...held.keys()].map((key) => key.replace('local::', '')).sort()
}

function watchOps(): number {
  const ops = watched.length + unwatched.length
  watched = []
  unwatched = []
  return ops
}

function nestedFolders(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${OUTER}/pkg-${i}/src`)
}

it('holds one watch while the outer folder is open, and returns to it after closing and reopening', async () => {
  for (const n of [10, 100]) {
    watched = []
    unwatched = []
    const folders = new SymlinkedTabFolderWatches(() => {})
    const held: HeldWatchRoots = new Map()
    const nested = nestedFolders(n)
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    expect([watchOps(), heldPaths(held)]).toEqual([1, [OUTER]])
    folders.sync(tabsIn(nested), TARGETS, held)
    await settle()
    // Why N+1: the nested folders take their own watches, then the outer one goes.
    expect([watchOps(), heldPaths(held)]).toEqual([n + 1, [...nested].sort()])
    // The reopened folder's probe answers late; it is still the outer root right away.
    slowProbes.add(OUTER)
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    expect([watchOps(), heldPaths(held)]).toEqual([n + 1, [OUTER]])
    slowProbes.clear()
    // A preview-tab swap: closed and reopened within the grace, nothing changes.
    folders.sync(tabsIn(nested), TARGETS, held)
    await vi.advanceTimersByTimeAsync(29_000)
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    expect([watchOps(), heldPaths(held)]).toEqual([0, [OUTER]])
    // Closing everything at once asks for no narrower watch on the way out, and leaves no grace timer behind.
    folders.sync(tabsIn([]), TARGETS, held)
    expect(vi.getTimerCount()).toBe(0)
    await settle()
    expect([watched, heldPaths(held)]).toEqual([[], []])
  }
})

it('keeps the outer watch, and its route, when a narrower watch fails to install', async () => {
  for (const n of [10, 100]) {
    const folders = new SymlinkedTabFolderWatches(() => {})
    const held: HeldWatchRoots = new Map()
    const nested = nestedFolders(n)
    const [broken, ...healthy] = nested
    watchResults.set(broken, 'unavailable')
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    folders.sync(tabsIn(nested), TARGETS, held)
    await settle()
    // The outer watch stays for the folder whose own watch failed, and the others share it rather than doubling up.
    expect(heldPaths(held)).toEqual([OUTER])
    // An external edit the outer watch reports still reaches that folder's workspace.
    expect(folders.targetsFor(OUTER, undefined, held)).toEqual([target])
    folders.sync(tabsIn(healthy), TARGETS, held)
    await settle()
    expect(heldPaths(held)).toEqual([...healthy].sort())
    watchResults.clear()
  }
})

it('closing every tab while one leans on the outer watch asks for no watch on the way out', async () => {
  for (const n of [10, 100]) {
    const folders = new SymlinkedTabFolderWatches(() => {})
    const held: HeldWatchRoots = new Map()
    const nested = nestedFolders(n)
    watchResults.set(nested[0], 'unavailable')
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    folders.sync(tabsIn(nested), TARGETS, held)
    await settle()
    expect(heldPaths(held)).toEqual([OUTER])
    watched = []
    folders.sync(tabsIn([]), TARGETS, held)
    await settle()
    expect([watched, heldPaths(held)]).toEqual([[], []])
    watchResults.clear()
  }
})

it('retries a failed watch when a second workspace opens the same folder', async () => {
  const second: EditorExternalWatchTarget = { ...target, worktreeId: 'wt-2' }
  const both = [target, second]
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  const folder = `${OUTER}/a`
  watchResults.set(folder, 'unavailable')
  folders.sync(selectLocalTabFoldersKey(filesIn([folder], target), both), both, held)
  await settle()
  watchResults.clear()
  watched = []
  const fromBoth = [...filesIn([folder], target), ...filesIn([folder], second)]
  folders.sync(selectLocalTabFoldersKey(fromBoth, both), both, held)
  await settle()
  expect([watched, heldPaths(held)]).toEqual([[folder], [folder]])
  expect(folders.targetsFor(folder, undefined, held)).toEqual(both)
})

it('keeps narrower watches until a deferred outer watch is installed', async () => {
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  const nested = nestedFolders(10)
  folders.sync(tabsIn(nested), TARGETS, held)
  await settle()
  watchResults.set(OUTER, 'deferred')
  folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
  await settle()
  expect(heldPaths(held)).toEqual([OUTER, ...nested].sort())
  // Main's resync after the deferred install lands: the root re-asks main, then the folders re-plan.
  watchResults.set(OUTER, 'watching')
  await refreshDeferredWatchRoot(held, { worktreePath: OUTER, connectionId: undefined }, () => {})
  folders.noteSettled(OUTER, held)
  await settle()
  expect(heldPaths(held)).toEqual([OUTER])
})

it('keeps a watch for folders the outer watch cannot see', async () => {
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  const pastSecondLink = '/ws/linked/deep/inner/x'
  const ignored = '/ws/linked/node_modules/pkg'
  const children = ['/ws/linked/a', '/ws/linked/Build/b']
  folders.sync(tabsIn([pastSecondLink, ignored, ...children, OUTER]), TARGETS, held)
  await settle()
  expect(heldPaths(held)).toEqual([OUTER, ignored, pastSecondLink].sort())
  folders.sync(tabsIn([pastSecondLink, ignored]), TARGETS, held)
  await settle()
  expect(heldPaths(held)).toEqual([ignored, pastSecondLink].sort())
})

it('releases every watch when all tabs close while the narrower watches are still installing', async () => {
  for (const n of [10, 100]) {
    stalledInstalls = new Map()
    const folders = new SymlinkedTabFolderWatches(() => {})
    const held: HeldWatchRoots = new Map()
    const nested = nestedFolders(n)
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    folders.sync(tabsIn(nested), TARGETS, held)
    await settle()
    expect(stalledInstalls.size).toBe(n)
    folders.sync(tabsIn([]), TARGETS, held)
    await settle()
    expect(held.size).toBe(0)
  }
})

it('releases folder watches when only a workspace rooted at the link still shows those folders', async () => {
  for (const n of [10, 100]) {
    const folders = new SymlinkedTabFolderWatches(() => {})
    const held: HeldWatchRoots = new Map()
    const nested = nestedFolders(n)
    const fromLinkedRoot = filesIn(nested, linkedRoot)
    folders.sync(tabsIn(nested), TARGETS, held)
    await settle()
    folders.sync(tabsIn(nested, fromLinkedRoot), TARGETS, held)
    await settle()
    folders.sync(tabsIn([], fromLinkedRoot), TARGETS, held)
    await settle()
    expect(held.size).toBe(0)
  }
})

it('asks for a failed shared watch once while its folder stays open', async () => {
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  const shared = `${OUTER}/pkg`
  const nested = Array.from({ length: 10 }, (_, i) => `${shared}/c-${i}`)
  // The shared folder is open only in the workspace rooted at the link, so it never probes as linked itself.
  const sharedFromLinkedRoot = filesIn([shared], linkedRoot)
  watchResults.set(shared, 'unavailable')
  folders.sync(tabsIn(nested, sharedFromLinkedRoot), TARGETS, held)
  await settle()
  for (let i = 0; i < 5; i += 1) {
    folders.sync(tabsIn(nested.slice(0, 9 - i), sharedFromLinkedRoot), TARGETS, held)
    await settle()
  }
  expect(watched.filter((path) => path === shared)).toEqual([shared])
  expect(heldPaths(held)).toEqual(nested.slice(0, 5).sort())
})

it('plans in time linear in the folders a change touches', async () => {
  const counts: number[][] = []
  for (const n of [100, 1000]) {
    const folders = new SymlinkedTabFolderWatches(() => {})
    const held: HeldWatchRoots = new Map()
    const nested = nestedFolders(n)
    statusReads = 0
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    const restore = statusReads
    statusReads = 0
    folders.sync(tabsIn([OUTER, ...nested, '/ws/plain']), TARGETS, held)
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    folders.sync(tabsIn([OUTER, `${OUTER}/pkg-0`, ...nested]), TARGETS, held)
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    // Why counted with unrelated tabs: an open folder under an already-open outer one changes no folder's watch.
    const unrelated = statusReads
    statusReads = 0
    folders.sync(tabsIn(nested), TARGETS, held)
    await settle()
    folders.sync(tabsIn([OUTER, ...nested]), TARGETS, held)
    await settle()
    counts.push([restore, unrelated, statusReads])
  }
  const [[restore, unrelated, swap], [restore10, unrelated10, swap10]] = counts
  // A plain tab costs nothing; one under an open outer folder checks that outer folder once, at any N.
  expect([unrelated, unrelated10]).toEqual([1, 1])
  // Ten times the folders costs about ten times the work, not a hundred.
  expect(restore10 / restore).toBeLessThan(12)
  expect(swap10 / swap).toBeLessThan(12)
})
