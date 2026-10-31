import { expect, it, type Mock } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { AppState } from '../types'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import {
  carryFetchedProjectGroupingOverrides,
  retireRemovedProjectGroupingState
} from '../repos/project-grouping-preferences'

function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  let reject: (reason?: unknown) => void = () => {}
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

export function registerSettingsGroupingPreferenceTests(settingsSet: Mock, settingsGet: Mock) {
  it('serializes overlapping identity promotions, authoritative retirement and manual override edits against acknowledged settings', async () => {
    const store = createTestStore()
    const firstAck = deferred<void>()
    let saved = {
      ...getDefaultSettings('/tmp'),
      projectGroupingOverrides: {
        'repo:a': 'folder',
        'repo:b': 'host',
        'repo:removed': 'folder',
        offline: 'host'
      }
    } satisfies NonNullable<AppState['settings']>
    settingsSet.mockImplementation(async (updates) => {
      if (settingsSet.mock.calls.length === 1) {
        await firstAck.promise
      }
      saved = { ...saved, ...updates }
      return saved
    })
    const repos = ['a', 'b', 'removed'].map((id) => ({
      id,
      path: `/repos/${id}`,
      displayName: id,
      badgeColor: '',
      addedAt: 0
    }))
    const previous = projectHostSetupProjectionFromRepos(repos)
    const promoted = repos.slice(0, 2).map((repo) => ({
      ...repo,
      gitRemoteIdentity: {
        canonicalKey: `gitlab.com/acme/${repo.id}`,
        remoteName: 'origin',
        remoteUrl: `git@gitlab.com:acme/${repo.id}.git`
      }
    }))
    const next = projectHostSetupProjectionFromRepos(promoted)
    store.setState({
      settings: saved,
      repos: promoted,
      projects: next.projects,
      projectHostSetups: next.setups
    })
    carryFetchedProjectGroupingOverrides(store.getState, [previous.projects[0]])
    carryFetchedProjectGroupingOverrides(store.getState, [previous.projects[1]])
    retireRemovedProjectGroupingState(store.getState, repos[2])
    const manualEdit = store.getState().updateSettingsOrThrow((current) => ({
      projectGroupingOverrides: { ...current.projectGroupingOverrides, manual: 'folder' }
    }))
    expect(settingsSet).toHaveBeenCalledTimes(1)
    firstAck.resolve()
    await manualEdit
    expect(saved.projectGroupingOverrides).toEqual({
      'git:gitlab.com/acme/a': 'folder',
      'git:gitlab.com/acme/b': 'host',
      offline: 'host',
      manual: 'folder'
    })
    expect(store.getState().settings).toEqual(saved)
    settingsGet.mockResolvedValue(saved)
    await store.getState().fetchSettings()
    expect(store.getState().settings?.projectGroupingOverrides).toEqual(
      saved.projectGroupingOverrides
    )
    settingsSet.mockRejectedValueOnce(new Error('write failed'))
    await expect(
      store.getState().updateSettingsOrThrow(() => ({ projectGroupingMode: 'host' }))
    ).rejects.toThrow('write failed')
    await store.getState().updateSettingsOrThrow((current) => ({
      projectGroupingOverrides: {
        ...current.projectGroupingOverrides,
        afterFailure: 'repository'
      }
    }))
    expect(store.getState().settings?.projectGroupingOverrides.afterFailure).toBe('repository')
  })

  it('does not let a concurrent refresh fence out an acknowledged override before the next transform', async () => {
    const store = createTestStore()
    let saved = {
      ...getDefaultSettings('/tmp'),
      projectGroupingOverrides: { offline: 'host' as const }
    }
    store.setState({ settings: saved })
    const ack = deferred<void>()
    settingsGet.mockImplementation(async () => saved)
    settingsSet.mockImplementation(async (patch) => {
      if (settingsSet.mock.calls.length === 1) {
        await ack.promise
      }
      saved = { ...saved, ...patch }
      return saved
    })
    const migration = store.getState().updateSettingsOrThrow((current) => ({
      projectGroupingOverrides: { ...current.projectGroupingOverrides, promoted: 'folder' }
    }))
    const refresh = store.getState().fetchSettings()
    const edit = store.getState().updateSettingsOrThrow((current) => ({
      projectGroupingOverrides: { ...current.projectGroupingOverrides, manual: 'repository' }
    }))
    ack.resolve()
    await Promise.all([migration, refresh, edit])
    expect(saved.projectGroupingOverrides).toEqual({
      offline: 'host',
      promoted: 'folder',
      manual: 'repository'
    })
    expect(store.getState().settings?.projectGroupingOverrides).toEqual(
      saved.projectGroupingOverrides
    )
  })
}
