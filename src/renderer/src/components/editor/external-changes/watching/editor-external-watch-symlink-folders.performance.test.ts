// Guards STA-14938 (PR #49252): open tabs in nested folders behind one symlink share the outermost folder's
// recursive watch instead of each holding an overlapping one, and closing that folder's tab re-watches nothing.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import type { HeldWatchRoots } from './editor-external-watch-local-roots'
import {
  selectLocalTabFoldersKey,
  SymlinkedTabFolderWatches
} from './editor-external-watch-symlink-folders'

const ROOT = '/ws'
const LINKS = ['/ws/linked', '/ws/linked/deep/inner']
const target: EditorExternalWatchTarget = {
  worktreeId: 'wt',
  worktreePath: ROOT,
  connectionId: undefined,
  runtimeEnvironmentId: null
}

let watched: string[] = []
let unwatched: string[] = []
/** Folders whose probe answers only after the others. */
let slowProbes = new Set<string>()
let releaseSlowProbes: (() => void)[] = []

beforeEach(() => {
  watched = []
  unwatched = []
  slowProbes = new Set()
  releaseSlowProbes = []
  vi.stubGlobal('window', {
    api: {
      fs: {
        findDeepestSymlinkBelowRoot: async ({ path }: { path: string }) => {
          if (slowProbes.has(path)) {
            await new Promise<void>((resolve) => releaseSlowProbes.push(resolve))
          }
          return LINKS.findLast((link) => path === link || path.startsWith(`${link}/`)) ?? null
        },
        watchWorktree: async ({ worktreePath }: { worktreePath: string }) => {
          watched.push(worktreePath)
        },
        unwatchWorktree: async ({ worktreePath }: { worktreePath: string }) => {
          unwatched.push(worktreePath)
        }
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function tabsIn(folders: string[]): string {
  const openFiles: AppState['openFiles'] = folders.map((folder, index) => ({
    id: `tab-${index}`,
    worktreeId: target.worktreeId,
    filePath: `${folder}/file.md`,
    relativePath: `${folder.slice(ROOT.length + 1)}/file.md`,
    language: 'markdown',
    isDirty: false,
    mode: 'edit'
  }))
  return selectLocalTabFoldersKey(openFiles, [target])
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

/** Watch requests for opening N nested tabs plus their outer tab, then closing the outer tab. */
async function watchRequestsForNestedTabs(n: number): Promise<[number, number]> {
  watched = []
  unwatched = []
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  const nested = Array.from({ length: n }, (_, i) => `/ws/linked/pkg-${i}/src`)
  folders.sync(tabsIn(['/ws/linked', ...nested]), [target], held)
  await settle()
  const opened = watched.length
  folders.sync(tabsIn(nested), [target], held)
  await settle()
  return [opened, watched.length - opened + unwatched.length]
}

it('holds one watch for any number of tab folders under one linked folder', async () => {
  expect(await watchRequestsForNestedTabs(10)).toEqual([1, 0])
  expect(await watchRequestsForNestedTabs(100)).toEqual([1, 0])
  slowProbes.add('/ws/linked')
  expect(await watchRequestsForNestedTabs(10)).toEqual([1, 0])
  expect(await watchRequestsForNestedTabs(100)).toEqual([1, 0])
})

it('keeps a watch for folders the outer watch cannot see, and drops each watch once it covers no tab', async () => {
  const folders = new SymlinkedTabFolderWatches(() => {})
  const held: HeldWatchRoots = new Map()
  const pastSecondLink = '/ws/linked/deep/inner/x'
  const ignored = '/ws/linked/node_modules/pkg'
  const children = ['/ws/linked/a', '/ws/linked/Build/b']
  folders.sync(tabsIn([pastSecondLink, ignored, ...children, '/ws/linked']), [target], held)
  await settle()
  expect(watched.sort()).toEqual(['/ws/linked', ignored, pastSecondLink].sort())

  watched = []
  folders.sync(tabsIn([pastSecondLink, ignored]), [target], held)
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
  folders.sync(tabsIn(['/ws/linked/a']), [target], held)
  await settle()
  folders.sync(tabsIn(['/ws/linked/a', '/ws/linked']), [target], held)
  await settle()
  folders.sync(tabsIn(['/ws/linked/a', '/ws/linked', '/ws/linked/b']), [target], held)
  await settle()
  expect(watched).toEqual(['/ws/linked/a', '/ws/linked'])
  expect(unwatched).toEqual([])
  expect(folders.targetsFor('/ws/linked', undefined)).toEqual([target])
})
