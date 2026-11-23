import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { RepoProjectFilterEntry } from './use-project-filter-entries'
import { SidebarProjectFilterPanel } from './SidebarProjectFilterPanel'

const noop = (): void => {}

function repo(id: string, displayName: string, badgeColor: string): Repo {
  return { id, path: `/projects/${displayName}`, displayName, badgeColor, addedAt: 0 }
}

function entry(key: string, label: string, repos: Repo[]): RepoProjectFilterEntry {
  return { key, label, repo: repos[0], repos, repoIds: repos.map((r) => r.id) }
}

// acme-web is checked out on three hosts; docs-site lives on one.
const acme = entry('project:github:acme/web', 'acme-web', [
  repo('acme-local', 'acme-web', '#3b82f6'),
  repo('acme-build-box', 'acme-web', '#3b82f6'),
  repo('acme-windows', 'acme-web', '#3b82f6')
])
const docs = entry('project:github:acme/docs', 'docs-site', [
  repo('docs-local', 'docs-site', '#22c55e')
])

function Panel({ selected }: { selected: RepoProjectFilterEntry[] }): React.JSX.Element {
  return (
    <div className="w-64 rounded-md border border-border bg-popover p-1 text-popover-foreground">
      <SidebarProjectFilterPanel
        availableEntries={[acme, docs].filter((candidate) => !selected.includes(candidate))}
        selectedEntries={selected}
        hasRepoFilter={selected.length > 0}
        filterRepoIds={selected.flatMap((candidate) => candidate.repoIds)}
        setFilterRepoIds={noop}
      />
    </div>
  )
}

export const projectOnSeveralHosts = defineFixture({
  width: 280,
  render: () => <Panel selected={[]} />
})

export const projectOnSeveralHostsSelected = defineFixture({
  width: 280,
  render: () => <Panel selected={[acme]} />
})
