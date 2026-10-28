import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import { getSetupScriptPromptDismissalKey } from '../../lib/setup-script-prompt'
import { createTestStore } from '../slices/store-test-helpers'
import { createUIStore, makePersistedUI } from '../slices/ui-slice-test-harness'
import {
  withWslMovedRepoIds,
  withWslMovedSetupScriptDismissals
} from './wsl-moved-repo-ui-retention'

const moved: WslMovedProject = {
  kind: 'repo',
  id: 'moved-repo',
  displayName: 'Moved',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\moved',
  distro: 'Ubuntu'
}
const movedFolder: WslMovedProject = { ...moved, kind: 'folder', id: 'moved-folder' }
const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const hostDismissal = getSetupScriptPromptDismissalKey('runtime:wsl-env\0moved-repo')
const localDismissal = getSetupScriptPromptDismissalKey('local\0moved-repo')
const staleDismissal = getSetupScriptPromptDismissalKey('local\0stale-repo')
const trust = (approvedAt: number) => ({ all: { approvedAt } })

describe('WSL moved repo UI retention', () => {
  it('returns its input unchanged without a moved repo', () => {
    const valid = new Set(['local-repo'])
    expect(withWslMovedRepoIds(valid, [])).toBe(valid)
    expect(withWslMovedRepoIds(valid, undefined)).toBe(valid)
    expect(withWslMovedRepoIds(valid, [movedFolder])).toBe(valid)
    const retained = ['a']
    expect(withWslMovedSetupScriptDismissals([staleDismissal], retained, [])).toBe(retained)
  })

  it('adds the moved repos, also when no other repo is listed', () => {
    expect([...withWslMovedRepoIds(new Set(['local-repo']), [moved])]).toEqual([
      'local-repo',
      'moved-repo'
    ])
    expect([...withWslMovedRepoIds(new Set(), [moved])]).toEqual(['moved-repo'])
  })

  it('hands back the persisted dismissals when nothing was pruned', () => {
    const persisted = [hostDismissal, localDismissal]
    expect(withWslMovedSetupScriptDismissals(persisted, [], [moved])).toBe(persisted)
  })

  it('keeps every dismissal of a moved repo, whichever host it names', () => {
    expect(
      withWslMovedSetupScriptDismissals(
        [hostDismissal, localDismissal, staleDismissal],
        [],
        [moved]
      )
    ).toEqual([hostDismissal, localDismissal])
  })
})

describe('catalog prune with a moved project', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      api: {
        repos: { list: vi.fn().mockResolvedValue([localRepo]) },
        ui: { set: vi.fn().mockResolvedValue(undefined) },
        projects: {
          list: vi.fn().mockResolvedValue([]),
          listHostSetups: vi.fn().mockResolvedValue([])
        },
        // The WSL environment is missing from this load, so the moved repo's host row is too.
        runtimeEnvironments: { list: vi.fn().mockResolvedValue([]), call: vi.fn() }
      },
      dispatchEvent: vi.fn()
    })
  })

  const seeded = {
    filterRepoIds: ['moved-repo', 'stale-repo'],
    setupScriptPromptDismissedRepoIds: [hostDismissal, staleDismissal],
    trustedOrcaHooks: { 'moved-repo': trust(1), 'stale-repo': trust(2) }
  }

  it('keeps the moved repo filter, trust and dismissals when its host is absent', async () => {
    const store = createTestStore()
    store.setState({ ...seeded, wslMovedProjects: [moved] })
    await store.getState().fetchReposForAllHosts()
    expect(store.getState().filterRepoIds).toEqual(['moved-repo'])
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([hostDismissal])
    expect(store.getState().trustedOrcaHooks).toEqual({ 'moved-repo': trust(1) })
  })

  it('keeps them when the moved repo was the only one listed', async () => {
    window.api.repos.list = vi.fn().mockResolvedValue([])
    const store = createTestStore()
    store.setState({ ...seeded, wslMovedProjects: [moved] })
    await store.getState().fetchReposForAllHosts()
    expect(store.getState().filterRepoIds).toEqual(['moved-repo'])
    expect(store.getState().trustedOrcaHooks).toEqual({ 'moved-repo': trust(1) })
  })

  it('keeps the moved repo filter and dismissals through a local-only refresh', async () => {
    const store = createTestStore()
    store.setState({ ...seeded, wslMovedProjects: [moved], settings: getDefaultSettings('/home') })
    await store.getState().fetchRepos({ runtimeEnvironmentId: null })
    expect(store.getState().filterRepoIds).toEqual(['moved-repo'])
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([hostDismissal])
  })

  it('prunes exactly as before without a moved project', async () => {
    const store = createTestStore()
    store.setState(seeded)
    await store.getState().fetchReposForAllHosts()
    expect(store.getState().filterRepoIds).toEqual([])
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([])
    expect(store.getState().trustedOrcaHooks).toEqual({})
  })

  it('keeps them through a UI re-hydration too, and only for the moved repo', () => {
    const ui = makePersistedUI({
      ...seeded,
      agentsFilterRepoIds: ['moved-repo', 'stale-repo']
    })
    const withMove = createUIStore()
    withMove.setState({ repos: [localRepo], wslMovedProjects: [moved] })
    withMove.getState().hydratePersistedUI(ui)
    expect(withMove.getState().filterRepoIds).toEqual(['moved-repo'])
    expect(withMove.getState().agentsFilterRepoIds).toEqual(['moved-repo'])
    expect(withMove.getState().trustedOrcaHooks).toEqual({ 'moved-repo': trust(1) })
    expect(withMove.getState().setupScriptPromptDismissedRepoIds).toEqual([hostDismissal])

    const without = createUIStore()
    without.setState({ repos: [localRepo] })
    without.getState().hydratePersistedUI(ui)
    expect(without.getState().filterRepoIds).toEqual([])
    expect(without.getState().agentsFilterRepoIds).toEqual([])
    expect(without.getState().trustedOrcaHooks).toEqual({})
    expect(without.getState().setupScriptPromptDismissedRepoIds).toEqual([])
  })
})
