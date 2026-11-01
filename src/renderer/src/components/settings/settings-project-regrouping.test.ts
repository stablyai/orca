import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'

import { createUIStore } from '../../store/slices/ui-slice-test-harness'

import {
  buildSettingsProjectList,
  getSettingsEntryHostSelection,
  getSettingsProjectHostRepo,
  getSettingsTargetHostSelection,
  type SettingsProject
} from './settings-project-list'

const gitRemoteIdentity = {
  canonicalKey: 'gitlab.com/acme/app',
  remoteName: 'origin',
  remoteUrl: 'git@gitlab.com:acme/app.git'
}

function makeRepo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: '', addedAt: 0, gitRemoteIdentity }
}

const nativeA = makeRepo('native-a', 'C:\\projects\\app-a')
const nativeB = makeRepo('native-b', 'C:\\projects\\app-b')
const wslA = makeRepo('wsl-a', '\\\\wsl.localhost\\Ubuntu\\home\\fixture\\app-a')

function pickRepo(
  store: ReturnType<typeof createUIStore>,
  entries: SettingsProject[],
  repo: Repo
): void {
  const target = getSettingsTargetHostSelection(entries, repo.id, 'local')
  if (!target) {
    throw new Error(`Missing Settings target for ${repo.id}`)
  }
  store
    .getState()
    .setSettingsProjectHostSelection(target.selectionKey, target.hostId, target.setupId)
}

function selectedRepo(store: ReturnType<typeof createUIStore>, repos: Repo[], repo: Repo): Repo {
  const entry = buildSettingsProjectList(repos).find((candidate) =>
    candidate.setups.some((setup) => setup.repoId === repo.id)
  )
  if (!entry) {
    throw new Error(`Missing Settings entry for ${repo.id}`)
  }
  const state = store.getState()
  const selection = getSettingsEntryHostSelection(
    entry,
    state.settingsProjectHostSelection,
    state.settingsProjectSetupSelection
  )
  const result = getSettingsProjectHostRepo(entry, repos, selection.hostId, selection.setupId)
  if (!result) {
    throw new Error(`Missing selected Settings repo for ${repo.id}`)
  }
  return result
}

describe('Settings project selection across local checkout regrouping', () => {
  it('keeps a newer project-level WSL pick when an older checkout selection still exists', () => {
    const store = createUIStore()
    pickRepo(store, buildSettingsProjectList([nativeA, nativeB, wslA]), nativeA)
    pickRepo(store, buildSettingsProjectList([nativeA, wslA]), wslA)

    expect(selectedRepo(store, [nativeA, nativeB, wslA], nativeA).path).toBe(nativeA.path)
    expect(selectedRepo(store, [nativeA, nativeB, wslA], wslA).path).toBe(wslA.path)
    expect(selectedRepo(store, [nativeA, wslA], nativeA).path).toBe(wslA.path)
  })

  it('refreshes recency when the same checkout is picked again after a project pick', () => {
    const store = createUIStore()
    const split = buildSettingsProjectList([nativeA, nativeB, wslA])
    pickRepo(store, split, nativeA)
    pickRepo(store, buildSettingsProjectList([nativeA, wslA]), wslA)
    pickRepo(store, split, nativeA)

    expect(selectedRepo(store, [nativeA, wslA], nativeA).path).toBe(nativeA.path)
  })

  it('does not carry a sibling checkout pick into the remaining project', () => {
    const store = createUIStore()
    const split = buildSettingsProjectList([nativeA, nativeB, wslA])
    pickRepo(store, buildSettingsProjectList([nativeA, wslA]), wslA)
    pickRepo(store, split, nativeA)
    pickRepo(store, split, nativeB)

    expect(selectedRepo(store, [nativeA, nativeB, wslA], nativeA).path).toBe(nativeA.path)
    expect(selectedRepo(store, [nativeA, nativeB, wslA], nativeB).path).toBe(nativeB.path)
    expect(selectedRepo(store, [nativeA, wslA], nativeA).path).toBe(nativeA.path)
  })
})
