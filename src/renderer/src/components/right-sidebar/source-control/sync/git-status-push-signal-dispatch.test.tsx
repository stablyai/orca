// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as CrossPlatformPath from '../../../../../../shared/cross-platform-path'
import type * as WorkspaceRecordSelectors from '@/store/workspace-record-selectors'
import type {
  GitStatusMetadataChangedEvent,
  Worktree
} from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { useGitStatusPushSignalRefresh } from './git-status-push-signal-refresh'

const counters = vi.hoisted(() => ({ normalizations: 0, catalogReads: 0 }))
vi.mock('../../../../../../shared/cross-platform-path', async (original) => {
  const actual = await original<typeof CrossPlatformPath>()
  return {
    ...actual,
    normalizeRuntimePathForComparison: (value: string) => {
      counters.normalizations += 1
      return actual.normalizeRuntimePathForComparison(value)
    }
  }
})
vi.mock('@/store/workspace-record-selectors', async (original) => {
  const actual = await original<typeof WorkspaceRecordSelectors>()
  return {
    ...actual,
    selectWorktreesByRepo: (...args: Parameters<typeof actual.selectWorktreesByRepo>) => {
      counters.catalogReads += 1
      return actual.selectWorktreesByRepo(...args)
    }
  }
})

const metadataListeners = new Set<(signal: GitStatusMetadataChangedEvent) => void>()
const repoListeners = new Set<(signal: { repoId: string }) => void>()
let root: Root
let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', {
    worktrees: {
      onChanged: (listener: (signal: { repoId: string }) => void) => {
        repoListeners.add(listener)
        return () => repoListeners.delete(listener)
      },
      onGitStatusMetadataChanged: (listener: (signal: GitStatusMetadataChangedEvent) => void) => {
        metadataListeners.add(listener)
        return () => metadataListeners.delete(listener)
      }
    }
  })
  visibility = 'visible'
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })
  useAppStore.setState(useAppStore.getInitialState(), true)
  root = createRoot(document.createElement('div'))
})
afterEach(async () => {
  await act(async () => root.unmount())
  Reflect.deleteProperty(document, 'visibilityState')
  vi.unstubAllGlobals()
})

type ObserverSpec = { repoId: string; id: string; path: string | null }

function Observer({ spec, fetches }: { spec: ObserverSpec; fetches: string[] }) {
  useGitStatusPushSignalRefresh({
    enabled: true,
    activeRepoId: spec.repoId,
    activeWorktreeId: spec.id,
    activeWorktreePath: spec.path,
    fetchStatus: recorders(spec.id, fetches)
  })
  return null
}
const recorderCache = new Map<string, () => void>()
// Stable per observer, as the production scheduler callback is.
function recorders(id: string, fetches: string[]): () => void {
  let recorder = recorderCache.get(id)
  if (!recorder) {
    recorder = () => fetches.push(id)
    recorderCache.set(id, recorder)
  }
  return recorder
}

function row(id: string, path: string): Worktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dispatcher reads only id and path from catalog rows.
  return { id, repoId: 'repo', path } as Worktree
}

async function mount(specs: readonly ObserverSpec[], fetches: string[]): Promise<void> {
  await act(async () =>
    root.render(
      <>
        {specs.map((spec) => (
          <Observer key={spec.id} spec={spec} fetches={fetches} />
        ))}
      </>
    )
  )
}

function send(signal: GitStatusMetadataChangedEvent): void {
  for (const listener of metadataListeners) {
    listener(signal)
  }
}

it.each([3, 30])(
  'refreshes exactly the attributed observers among %i same-repository worktrees',
  async (count) => {
    recorderCache.clear()
    const fetches: string[] = []
    const siblings = Array.from({ length: count }, (_, i) => ({
      repoId: 'repo',
      id: `wt-${i}`,
      path: `/repo/wt-${i}`
    }))
    const windows = { repoId: 'repo', id: 'wt-win', path: 'C:\\Repo\\WT-Win' }
    const pathless = { repoId: 'repo', id: 'wt-pathless', path: null }
    const otherRepo = { repoId: 'other', id: 'other-0', path: '/other/wt-0' }
    useAppStore.setState({
      worktreesByRepo: {
        repo: [...siblings.map((spec) => row(spec.id, spec.path)), row(windows.id, windows.path)],
        other: [row(otherRepo.id, otherRepo.path)]
      }
    })
    await mount([...siblings, windows, pathless, otherRepo], fetches)
    const repoIds = [...siblings.map((spec) => spec.id), windows.id, pathless.id]
    const knownPathCount = count + 1

    const dispatch = (signal: GitStatusMetadataChangedEvent) => {
      fetches.length = 0
      counters.normalizations = 0
      counters.catalogReads = 0
      send(signal)
      return { recipients: [...fetches].sort(), ...counters }
    }

    // A known sibling refreshes only itself, plus an observer whose path is unknown.
    expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-1'] })).toEqual({
      recipients: ['wt-1', 'wt-pathless'],
      catalogReads: 1,
      normalizations: knownPathCount + 1
    })
    // Several attributed paths, one spelled with a trailing slash.
    expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-0', '/repo/wt-2/'] })).toEqual({
      recipients: ['wt-0', 'wt-2', 'wt-pathless'],
      catalogReads: 1,
      normalizations: knownPathCount + 2
    })
    // Windows drive paths compare case- and separator-insensitively.
    expect(dispatch({ repoId: 'repo', worktreePaths: ['c:/repo/wt-win/'] }).recipients).toEqual([
      'wt-pathless',
      'wt-win'
    ])
    // An unknown spelling may name any checkout, so the whole repository refreshes.
    expect(
      dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-1', '/elsewhere/link'] }).recipients
    ).toEqual([...repoIds].sort())
    // Legacy and empty attribution refresh the repository without reading the catalog.
    for (const worktreePaths of [undefined, []]) {
      expect(dispatch({ repoId: 'repo', worktreePaths })).toEqual({
        recipients: [...repoIds].sort(),
        catalogReads: 0,
        normalizations: 0
      })
    }

    // A hidden window catches up on reveal instead.
    visibility = 'hidden'
    expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-1'] })).toEqual({
      recipients: [],
      catalogReads: 0,
      normalizations: 0
    })
    visibility = 'visible'

    // A disposed observer stops receiving; the last one closes the app-wide subscription.
    await mount([...siblings.slice(2), windows, otherRepo], fetches)
    expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-1'] }).recipients).toEqual([])
    await act(async () => root.render(null))
    expect(metadataListeners.size).toBe(0)
    expect(repoListeners.size).toBe(0)
  }
)
