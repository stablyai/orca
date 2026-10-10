import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getProjectHostSetupForRepo } from '../../../../shared/project-host-setup-lookup'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { repoWithFetchedOwner } from '@/store/repos/owner-routing'
import { withRepoHostOwnership } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { createUIStore } from '@/store/slices/ui-slice-test-harness'
import { getRepoHostIdentity } from '@/store/slices/repo-host-identity'
import { getProjectHostSetupOwnerKey } from '@/store/projects/project-compatibility-core'
import {
  getSetupScriptPromptDismissalKey,
  isSetupScriptPromptDismissed
} from '@/lib/setup-script-prompt'
import { isSettingsNavigationTarget } from '@/lib/settings-navigation-types'
import {
  buildSettingsProjectList,
  getSettingsEntryHostSelection,
  getSettingsProjectHostRepo,
  getSettingsTargetHostSelection
} from '../settings/settings-project-list'
import { findSetupScriptPromptRepo } from './setup-script-prompt-render-state'
import { openSetupScriptSettings } from './open-setup-script-settings'

function receiverRepo(connectionId: string): Repo {
  return {
    id: 'remote-repo',
    path: '/srv/repo',
    displayName: connectionId,
    badgeColor: '',
    kind: 'git',
    addedAt: 1,
    connectionId,
    executionHostId: `ssh:${connectionId}`
  }
}

const a = repoWithFetchedOwner(receiverRepo('private-a'), {
  kind: 'environment',
  environmentId: 'env-1'
})
const b = repoWithFetchedOwner(receiverRepo('private-b'), {
  kind: 'environment',
  environmentId: 'env-1'
})
const worktreeB = withRepoHostOwnership(
  { repoId: b.id, hostId: 'ssh:private-b' as const },
  'runtime:env-1'
)

beforeEach(() => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each([
  ['forward', [a, b]],
  ['reverse', [b, a]]
] as const)('setup prompt raw owner routing: %s', (_order, repos) => {
  it('selects the active raw SSH owner from the actual catalog/listing projections', () => {
    expect(
      findSetupScriptPromptRepo({
        repos,
        activeRepoId: b.id,
        activeWorktree: worktreeB,
        settings: { activeRuntimeEnvironmentId: null }
      })
    ).toBe(b)
  })

  it('reads and writes B dismissal identity without suppressing A', () => {
    const selected = findSetupScriptPromptRepo({
      repos,
      activeRepoId: b.id,
      activeWorktree: worktreeB,
      settings: { activeRuntimeEnvironmentId: null }
    })
    expect(selected).toBe(b)
    if (!selected) {
      throw new Error('Missing active owner')
    }
    const store = createUIStore()
    store.getState().dismissSetupScriptPrompt(getRepoHostIdentity(selected))
    const dismissed = store.getState().setupScriptPromptDismissedRepoIds
    expect(dismissed).toEqual([getSetupScriptPromptDismissalKey(getRepoHostIdentity(b))])
    expect(isSetupScriptPromptDismissed(getRepoHostIdentity(b), dismissed)).toBe(true)
    expect(isSetupScriptPromptDismissed(getRepoHostIdentity(a), dismissed)).toBe(false)
  })

  it('opens and mounts B through the actual Settings target and selection store', () => {
    const projection = projectHostSetupProjectionFromRepos(repos)
    const setupId = getProjectHostSetupOwnerKey(getProjectHostSetupForRepo(projection.setups, b))
    const store = createUIStore()
    openSetupScriptSettings({
      repoId: b.id,
      hostId: 'runtime:env-1',
      setupId,
      setSettingsSearchQuery: store.getState().setSettingsSearchQuery,
      openSettingsTarget: store.getState().openSettingsTarget,
      openSettingsPage: store.getState().openSettingsPage
    })
    const target = store.getState().settingsNavigationTarget
    expect(target?.setupId).toBe(setupId)
    if (!target?.repoId || !target.hostId) {
      throw new Error('Missing Settings target')
    }
    const projects = buildSettingsProjectList(repos, {
      projects: projection.projects,
      projectHostSetups: projection.setups
    })
    const selection = getSettingsTargetHostSelection(
      projects,
      target.repoId,
      target.hostId,
      target.setupId
    )
    expect(selection).not.toBeNull()
    if (!selection) {
      throw new Error('Missing Settings selection')
    }
    store
      .getState()
      .setSettingsProjectHostSelection(selection.selectionKey, selection.hostId, selection.setupId)
    const entry = projects.find((project) => project.selectionKey === selection.selectionKey)
    if (!entry) {
      throw new Error('Missing Settings project')
    }
    const state = store.getState()
    const restored = getSettingsEntryHostSelection(
      entry,
      state.settingsProjectHostSelection,
      state.settingsProjectSetupSelection
    )
    expect(getSettingsProjectHostRepo(entry, repos, restored.hostId, restored.setupId)).toBe(b)
  })

  it('refuses a publisher-only Settings deep link when sibling owners are ambiguous', () => {
    expect(
      getSettingsTargetHostSelection(buildSettingsProjectList(repos), b.id, 'runtime:env-1')
    ).toBeNull()
  })
})

it('validates the existing Settings target with an opaque optional setup selection', () => {
  expect(
    isSettingsNavigationTarget({
      pane: 'repo',
      repoId: b.id,
      hostId: 'runtime:env-1',
      setupId: getProjectHostSetupOwnerKey(getProjectHostSetupForRepo([], b))
    })
  ).toBe(true)
  expect(
    isSettingsNavigationTarget({
      pane: 'repo',
      repoId: b.id,
      hostId: 'runtime:env-1',
      setupId: 123
    })
  ).toBe(false)
})

it('keeps paired-local runtime display ownership only when its publisher is unique', () => {
  const pairedLocal = repoWithFetchedOwner(
    { ...receiverRepo(''), connectionId: undefined, executionHostId: 'local' },
    { kind: 'environment', environmentId: 'env-1' }
  )
  const worktree = withRepoHostOwnership(
    { repoId: pairedLocal.id, hostId: 'local' as const },
    'runtime:env-1'
  )
  expect(worktree.hostId).toBe('runtime:env-1')
  const input = {
    activeRepoId: pairedLocal.id,
    activeWorktree: worktree,
    settings: { activeRuntimeEnvironmentId: null }
  }
  expect(findSetupScriptPromptRepo({ ...input, repos: [pairedLocal] })).toBe(pairedLocal)
  expect(findSetupScriptPromptRepo({ ...input, repos: [pairedLocal, a] })).toBeNull()
})

it('keeps a matching repository unrelated to the active workspace under the existing focus policy', () => {
  const local: Repo = {
    ...receiverRepo(''),
    id: 'other',
    connectionId: undefined,
    executionHostId: 'local'
  }
  expect(
    findSetupScriptPromptRepo({
      repos: [a, local],
      activeRepoId: local.id,
      activeWorktree: worktreeB,
      settings: { activeRuntimeEnvironmentId: null }
    })
  ).toBe(local)
})
