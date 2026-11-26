// Guards STA-14938 (PR #49252): open tabs in nested folders behind one symlink share the outermost folder's
// recursive watch instead of each holding an overlapping one. Guards STA-18470 (PR #49343): once the outer tab stays closed
// past the grace, that watch narrows to the nested folders, so its sibling tree stops reporting.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import type { HeldWatchRoots } from './editor-external-watch-local-roots'
import { SymlinkedTabFolderWatches } from './editor-external-watch-symlink-folders'
import { selectLocalTabFoldersKey } from './editor-external-watch-tab-folders-key'

const ROOT = '/ws'
const LINKS = ['/ws/linked', '/ws/linked/deep/inner']
const target: EditorExternalWatchTarget = {
  worktreeId: 'wt',
  worktreePath: ROOT,
  connectionId: undefined,
  runtimeEnvironmentId: null
}

/** A second workspace rooted at the link itself, so no link lies below its root. */
const linkedRoot: EditorExternalWatchTarget = {
  worktreeId: 'linked-root',
  worktreePath: '/ws/linked',
  connectionId: undefined,
  runtimeEnvironmentId: null
}

let watched: string[] = []
let unwatched: string[] = []
/** Folders whose probe answers only after the others. */
let slowProbes = new Set<string>()
let releaseSlowProbes: (() => void)[] = []
/** Watch requests main hasn't answered yet; releasing one aborts it, as main does. */
let stalledInstalls: Map<string, () => void> | undefined

beforeEach(() => {
  watched = []
  unwatched = []
  slowProbes = new Set()
  releaseSlowProbes = []
  stalledInstalls = undefined
  vi.useFakeTimers()
  vi.stubGlobal('window', {
    api: {
      fs: {
        findSymlinkBelowRoot: async ({ rootPath, path }: { rootPath: string; path: string }) => {
          if (rootPath === '/ws/linked') {
            return null
          }
          if (slowProbes.has(path)) {
            await new Promise<void>((resolve) => releaseSlowProbes.push(resolve))
          }
          return LINKS.findLast((link) => path === link || path.startsWith(`${link}/`)) ?? null
        },
        watchWorktree: async ({ worktreePath }: { worktreePath: string }) => {
          watched.push(worktreePath)
          if (stalledInstalls && worktreePath !== '/ws/linked') {
            await new Promise<void>((resolve) => stalledInstalls?.set(worktreePath, resolve))
          }
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

function tabsIn(folders: string[], owner = target, others: AppState['openFiles'] = []): string {
  return selectLocalTabFoldersKey([...filesIn(folders, owner), ...others], [target, linkedRoot])
}

function filesIn(folders: string[], owner: EditorExternalWatchTarget): AppState['openFiles'] {
  return folders.map((folder, index) => ({
    id: `${owner.worktreeId}-tab-${index}`,
    worktreeId: owner.worktreeId,
    filePath: `${folder}/file.md`,
    relativePath: `${folder.slice(ROOT.length + 1)}/file.md`,
    language: 'markdown',
    isDirty: false,
    mode: 'edit'
  }))
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve()
  }
}

/** Lets every other probe answer, then the slow ones. */
async function settle(): Promise<void> {
  await flushMicrotasks()
  for (const release of releaseSlowProbes.splice(0)) {
    release()
  }
  await flushMicrotasks()
}

function watchOps(): number {
  const ops = watched.length + unwatched.length
  watched = []
  unwatched = []
  return ops
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

/** Watch ops for N nested tabs plus their outer tab: opening, closing the outer tab and reopening it within the grace, then closing it for good. */
async function nestedTabWatchOps(
  n: number
): Promise<{ ops: number[]; held: string[]; drainRoutes: number[] }> {
  watched = []
  unwatched = []
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  const nested = Array.from({ length: n }, (_, i) => `/ws/linked/pkg-${i}/src`)
  folders.sync(tabsIn(['/ws/linked', ...nested]), [target, linkedRoot], held)
  await settle()
  const opened = watchOps()
  folders.sync(tabsIn(nested), [target, linkedRoot], held)
  await advance(29_000)
  folders.sync(tabsIn(['/ws/linked', ...nested]), [target, linkedRoot], held)
  await advance(60_000)
  const swapped = watchOps()
  folders.sync(tabsIn(nested), [target, linkedRoot], held)
  await advance(30_000)
  const routedDuringDrain = folders.targetsFor('/ws/linked', undefined).length
  await advance(1_000)
  const narrowed = watchOps()
  return {
    ops: [opened, swapped, narrowed],
    held: [...held.keys()].map((key) => key.replace('local::', '')).sort(),
    drainRoutes: [routedDuringDrain, folders.targetsFor('/ws/linked', undefined).length]
  }
}

it('holds one watch for nested tab folders, and narrows it once the outer tab stays closed', async () => {
  for (const n of [10, 100]) {
    const nested = Array.from({ length: n }, (_, i) => `/ws/linked/pkg-${i}/src`).sort()
    // Opening: 1 install (N+1 with one watch per folder). Closing the outer tab: N installs and 1 release, once.
    expect(await nestedTabWatchOps(n)).toEqual({
      ops: [1, 0, n + 1],
      held: nested,
      drainRoutes: [1, 0]
    })
  }
  slowProbes.add('/ws/linked')
  expect((await nestedTabWatchOps(10)).ops).toEqual([1, 0, 11])
  expect((await nestedTabWatchOps(100)).ops).toEqual([1, 0, 101])
})

it('keeps a watch for folders the outer watch cannot see, and drops each watch once it covers no tab', async () => {
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  const pastSecondLink = '/ws/linked/deep/inner/x'
  const ignored = '/ws/linked/node_modules/pkg'
  const children = ['/ws/linked/a', '/ws/linked/Build/b']
  folders.sync(
    tabsIn([pastSecondLink, ignored, ...children, '/ws/linked']),
    [target, linkedRoot],
    held
  )
  await settle()
  expect(watched.sort()).toEqual(['/ws/linked', ignored, pastSecondLink].sort())

  watched = []
  folders.sync(tabsIn([pastSecondLink, ignored]), [target, linkedRoot], held)
  await settle()
  expect(watched).toEqual([])
  expect(unwatched).toEqual(['/ws/linked'])
  expect([...held.keys()].map((key) => key.replace('local::', '')).sort()).toEqual(
    [ignored, pastSecondLink].sort()
  )
})

it('never releases a working watch when an outer folder opens later', async () => {
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  folders.sync(tabsIn(['/ws/linked/a']), [target, linkedRoot], held)
  await settle()
  folders.sync(tabsIn(['/ws/linked/a', '/ws/linked']), [target, linkedRoot], held)
  await settle()
  folders.sync(tabsIn(['/ws/linked/a', '/ws/linked', '/ws/linked/b']), [target, linkedRoot], held)
  await settle()
  expect(watched).toEqual(['/ws/linked/a', '/ws/linked'])
  expect(unwatched).toEqual([])
  expect(folders.targetsFor('/ws/linked', undefined)).toEqual([target])
})

it('releases every watch when all tabs close while the narrowed watches are still installing', async () => {
  for (const n of [10, 100]) {
    stalledInstalls = new Map()
    const folders = new SymlinkedTabFolderWatches(() => {})
    const held: HeldWatchRoots = new Map()
    const nested = Array.from({ length: n }, (_, i) => `/ws/linked/pkg-${i}/src`)
    folders.sync(tabsIn(['/ws/linked', ...nested]), [target, linkedRoot], held)
    await settle()
    folders.sync(tabsIn(nested), [target, linkedRoot], held)
    await advance(30_000)
    expect(stalledInstalls.size).toBe(n)
    folders.sync(tabsIn([]), [target, linkedRoot], held)
    await advance(1_000)
    expect(held.size).toBe(0)
  }
})

it('releases folder watches when only a workspace rooted at the link still shows those folders', async () => {
  for (const n of [10, 100]) {
    const folders = new SymlinkedTabFolderWatches(() => {})
    const held: HeldWatchRoots = new Map()
    const nested = Array.from({ length: n }, (_, i) => `/ws/linked/pkg-${i}/src`)
    folders.sync(tabsIn(nested), [target, linkedRoot], held)
    await settle()
    const fromLinkedRoot = filesIn(nested, linkedRoot)
    folders.sync(tabsIn(nested, target, fromLinkedRoot), [target, linkedRoot], held)
    await settle()
    folders.sync(tabsIn([], target, fromLinkedRoot), [target, linkedRoot], held)
    await settle()
    expect(held.size).toBe(0)
  }
})
