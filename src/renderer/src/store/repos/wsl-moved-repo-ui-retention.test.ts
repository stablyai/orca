import { beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import { getSetupScriptPromptDismissalKey } from '../../runtime/repo-hooks/setup-script-prompt'
import { createTestStore } from '../testing/app-store-test-fixture'
import { createUIStore, makePersistedUI } from '../slices/ui/ui-slice-test-harness'
import './wsl-moved-repo-ui-retention'

const moved: WslMovedProject = {
  kind: 'repo',
  id: 'moved-repo',
  displayName: 'Moved',
  path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\moved',
  distro: 'Ubuntu'
}
const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const hostDismissal = getSetupScriptPromptDismissalKey('runtime:wsl-env\0moved-repo')
const staleDismissal = getSetupScriptPromptDismissalKey('local\0stale-repo')
const trust = (approvedAt: number) => ({ all: { approvedAt } })

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
