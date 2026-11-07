import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { Repo } from '../../../../shared/repo-types'
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

    // Folder-only saved selections must fall back to an eligible repo rather than leave an empty picker.
    expect(resolveSelection(repos, ['folder'])).toEqual(['tracked'])
    expect(resolveSelection(repos, ['folder', 'tracked'])).toEqual(['tracked'])
  })
})
