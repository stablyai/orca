// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { useAppStore } from '../../store'
import { repoWithFetchedOwner } from '../../store/repos/owner-routing'
import type { RuntimeClientTarget } from '../../runtime/runtime-rpc-client'
import { setupWithFetchedOwner } from '../../store/projects/project-host-routing'
import { getProjectHostSetupOwnerKey } from '../../store/projects/project-compatibility-core'
import { RepositoryHostSetupsSection } from './RepositoryHostSetupsSection'
import {
  buildSettingsProjectList,
  getSettingsEntryHostSelection,
  getSettingsProjectHostRepo
} from './settings-project-list'

let container: HTMLDivElement
let root: Root

function SettingsHostPane(): React.JSX.Element {
  const repos = useAppStore((state) => state.repos)
  const projects = useAppStore((state) => state.projects)
  const projectHostSetups = useAppStore((state) => state.projectHostSetups)
  const hosts = useAppStore((state) => state.settingsProjectHostSelection)
  const setups = useAppStore((state) => state.settingsProjectSetupSelection)
  const entry = buildSettingsProjectList(repos, { projects, projectHostSetups })[0]
  const selection = getSettingsEntryHostSelection(entry, hosts, setups)
  const repo = getSettingsProjectHostRepo(entry, repos, selection.hostId, selection.setupId)
  if (!repo) {
    throw new Error('Missing settings owner')
  }
  return (
    <>
      <output data-mounted-path>{repo.path}</output>
      <RepositoryHostSetupsSection
        repo={repo}
        selectedProjectSetupId={selection.setupId}
        settingsSelectionKey={entry.selectionKey}
        forceVisible
        searchQuery=""
        searchEntries={[]}
      />
    </>
  )
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const OWNERS = [
  {
    label: 'paired private SSH',
    hosts: ['ssh:private-a', 'ssh:private-b'],
    target: { kind: 'environment', environmentId: 'paired' }
  },
  {
    label: 'paired legacy self stamp',
    hosts: ['local', 'runtime:legacy'],
    target: { kind: 'environment', environmentId: 'paired' }
  },
  { label: 'local SSH', hosts: ['local', 'ssh:private-b'], target: { kind: 'local' } },
  {
    label: 'local legacy self stamp',
    hosts: ['local', 'runtime:legacy'],
    target: { kind: 'local' }
  }
] satisfies { label: string; hosts: ExecutionHostId[]; target: RuntimeClientTarget }[]

describe('Settings Open preserves published setup ownership', () => {
  for (const { label, hosts, target } of OWNERS) {
    it.each([false, true])(`${label} rows through derived readers (B first: %s)`, (bFirst) => {
      const raw: Repo[] = hosts.map((host, index): Repo => ({
        id: 'shared-id',
        displayName: label,
        path: `/receiver/${index === 0 ? 'a' : 'b'}`,
        executionHostId: host,
        kind: 'folder',
        badgeColor: '#737373',
        addedAt: 100
      }))
      if (bFirst) {
        raw.reverse()
      }
      const projection = projectHostSetupProjectionFromRepos(raw)
      const repos = raw.map((repo) => repoWithFetchedOwner(repo, target))
      const projectHostSetups = projection.setups.map((setup) =>
        setupWithFetchedOwner(setup, target)
      )
      useAppStore.setState({ repos, projects: projection.projects, projectHostSetups })
      act(() => root.render(<SettingsHostPane />))
      const initialPath = container.querySelector('output')?.textContent
      const other = projectHostSetups.find((setup) => setup.path !== initialPath)
      if (!other) {
        throw new Error('Missing sibling setup')
      }
      const open = Array.from(container.querySelectorAll('button')).find(
        (button) =>
          button.textContent === 'Open' && button.parentElement?.textContent?.includes(other.path)
      )
      if (!open) {
        throw new Error(`Missing Open for ${other.path}`)
      }
      act(() => open.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      const state = useAppStore.getState()
      const entry = buildSettingsProjectList(state.repos, {
        projects: state.projects,
        projectHostSetups: state.projectHostSetups
      })[0]
      expect(state.settingsProjectSetupSelection[entry.selectionKey]).toBe(
        getProjectHostSetupOwnerKey(other)
      )
      expect(container.querySelector('output')?.textContent).toBe(other.path)
      expect(container.querySelector('[data-current="true"]')?.textContent).toContain(other.path)
    })
  }
})
