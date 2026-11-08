// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type {
  GitStatusMetadataChangedEvent,
  Worktree
} from '../../../../../../shared/worktree/types'
import { useAppStore } from '@/store'
import { useGitStatusPushSignalRefresh } from './git-status-push-signal-refresh'

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

it('refreshes exactly the attributed worktree observers', async () => {
  recorderCache.clear()
  const fetches: string[] = []
  const siblings = Array.from({ length: 3 }, (_, i) => ({
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

  const dispatch = (signal: GitStatusMetadataChangedEvent) => {
    fetches.length = 0
    send(signal)
    return [...fetches].sort()
  }

  // A known sibling refreshes only itself, plus an observer whose path is unknown.
  expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-1'] })).toEqual([
    'wt-1',
    'wt-pathless'
  ])
  // Several attributed paths, one spelled with a trailing slash.
  expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-0', '/repo/wt-2/'] })).toEqual([
    'wt-0',
    'wt-2',
    'wt-pathless'
  ])
  // Windows drive paths compare case- and separator-insensitively.
  expect(dispatch({ repoId: 'repo', worktreePaths: ['c:/repo/wt-win/'] })).toEqual([
    'wt-pathless',
    'wt-win'
  ])
  // An unknown spelling may name any checkout, so the whole repository refreshes.
  expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-1', '/elsewhere/link'] })).toEqual([
    'wt-0',
    'wt-1',
    'wt-2',
    'wt-pathless',
    'wt-win'
  ])
  // Legacy and empty attribution refresh the whole repository.
  for (const worktreePaths of [undefined, []]) {
    expect(dispatch({ repoId: 'repo', worktreePaths })).toEqual([
      'wt-0',
      'wt-1',
      'wt-2',
      'wt-pathless',
      'wt-win'
    ])
  }

  // A hidden window catches up on reveal instead.
  visibility = 'hidden'
  expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-1'] })).toEqual([])
  visibility = 'visible'

  // A disposed observer stops receiving.
  await mount([...siblings.slice(2), windows, otherRepo], fetches)
  expect(dispatch({ repoId: 'repo', worktreePaths: ['/repo/wt-1'] })).toEqual([])
  await act(async () => root.render(null))
})
