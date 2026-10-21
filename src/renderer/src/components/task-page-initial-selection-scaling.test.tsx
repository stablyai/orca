import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { Repo } from '../../../shared/repo-types'
import type { TaskPageStoreBindingsModel } from './use-task-page-store-bindings'
import { useTaskPageRepoSelection } from './use-task-page-repo-selection'

function resolveSelection(repos: Repo[], persisted: string[], preferred?: string) {
  let selected: readonly string[] = []
  function Probe() {
    const model = {
      repos,
      settings: { defaultRepoSelection: persisted },
      pageData: { preselectedRepoId: preferred },
      linearStatus: {},
      jiraStatus: {},
      preflightStatus: null
    } as unknown as TaskPageStoreBindingsModel
    useTaskPageRepoSelection(model)
    selected = [
      ...(model as TaskPageStoreBindingsModel & { resolvedInitialSelection: ReadonlySet<string> })
        .resolvedInitialSelection
    ]
    return null
  }
  renderToString(<Probe />)
  return selected
}

describe('task page initial repo selection', () => {
  it('normalizes persisted selections without a repository scan for every stored ID', () => {
    let reads = 0
    const repos: Repo[] = Array.from({ length: 1000 }, (_, index) => ({
      get id() {
        reads++
        return `repo-${index}`
      },
      path: `/repos/${index}`,
      displayName: `Repo ${index}`,
      badgeColor: '',
      addedAt: index,
      kind: 'git'
    }))
    const persisted = Array.from({ length: 1000 }, (_, index) => `repo-${index}`)
    expect(resolveSelection(repos, persisted)).toEqual(persisted)
    expect(reads).toBeLessThan(40_000)
  })

  it('retains preferred selection, missing-ID fallback, and explicit empty defaults', () => {
    const repos: Repo[] = ['a', 'b'].map((id) => ({
      id,
      path: `/repos/${id}`,
      displayName: id,
      badgeColor: '',
      addedAt: 0,
      kind: 'git'
    }))
    expect(resolveSelection(repos, ['b'], 'a')).toEqual(['a'])
    expect(resolveSelection(repos, ['missing'])).toEqual(['a', 'b'])
    expect(resolveSelection(repos, [])).toEqual(['a', 'b'])
    expect(resolveSelection(repos, ['missing', 'b', 'b'])).toEqual(['b'])
  })

  it('ignores persisted IDs for ineligible repos, including folder workspaces', () => {
    const repos: Repo[] = [
      {
        id: 'tracked',
        path: '/repos/tracked',
        displayName: 'tracked',
        badgeColor: '',
        addedAt: 0,
        kind: 'git'
      },
      {
        id: 'folder',
        path: '/repos/folder',
        displayName: 'folder',
        badgeColor: '',
        addedAt: 1,
        kind: 'folder'
      }
    ]

    // A folder workspace is never task-eligible, so a stored selection naming only one must fall
    // through to the automatic default rather than rendering an empty picker.
    expect(resolveSelection(repos, ['folder'])).toEqual(['tracked'])
    expect(resolveSelection(repos, ['folder', 'tracked'])).toEqual(['tracked'])
  })
})
