import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import type { StoreApi } from 'zustand'
import { githubTaskIdentity } from '@/lib/github-task-target'
import { getWorkItemRepo } from '@/lib/work-item-repo-row'
import { lookupReposBySlugFromCache } from '@/lib/repo-slug-cache'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { structuralValuesEqual } from '../../../../shared/structural-value-equality'
import { projectViewSourceScope } from './cache-identity'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { githubRepoIdentityKey } from '../../../../shared/github/repository-identity-key'
import { patchGitHubProjectRowContent } from './project-row-actions'
import { buildProjectWorkItem } from '@/components/github-project/project-work-item'
import { isEmptyTaskChange, type TaskChange, type TaskFacts } from './task-change'
import type { GitHubProjectRow, GitHubProjectTable } from '../../../../shared/github/project-types'
import {
  PROJECT_ASSIGNEE_LIMIT,
  PROJECT_LABEL_LIMIT,
  bindingKey,
  contribute,
  login,
  newestFirst,
  projectIssueLink,
  projectList,
  projectListConflicts,
  projectRowFacts,
  type AcceptedTask
} from './task-record-model'
import { TaskRecordReads } from './task-record-reads'

export type { TaskBinding } from './task-record-model'

/** The shared task record cache: owners and reads, plus the Project board surfaces of the same records. */
export class GitHubTaskRecordCache extends TaskRecordReads {
  /** A Project issue edit is a record producer for every current repo binding of that issue on its source. */
  projectOperation(
    row: GitHubProjectRow,
    host: string | undefined,
    target: RuntimeClientTarget,
    updates: Parameters<AppState['patchProjectIssueOrPr']>[2]
  ) {
    const link = projectIssueLink(row, host)
    const change: TaskChange = {
      ...(updates.title === undefined ? {} : { title: updates.title }),
      labels: Object.fromEntries([
        ...(updates.addLabels ?? []).map((name): [string, boolean] => [name, true]),
        ...(updates.removeLabels ?? []).map((name): [string, boolean] => [name, false])
      ]),
      assignees: Object.fromEntries([
        ...(updates.addAssignees ?? []).map((value): [string, GitHubAssignableUser | null] => [
          login(value),
          { login: value, name: null, avatarUrl: '' }
        ]),
        ...(updates.removeAssignees ?? []).map((value): [string, GitHubAssignableUser | null] => [
          login(value),
          null
        ])
      ])
    }
    // A body-only or empty save owns no issue fact: no owner, revision or read.
    if (!link || isEmptyTaskChange(change)) {
      return () => {}
    }
    const finishes = this.projectOwners(row, link, host, projectViewSourceScope(target)).map(
      ({ address, binding }) => this.operation(address, binding, change)
    )
    return (success: boolean) => {
      for (const finish of finishes) {
        finish(success)
      }
    }
  }
  /** Current repo bindings for this issue on the board's source; a cached copy only addresses its owner. */
  protected projectOwners(
    row: GitHubProjectRow,
    link: NonNullable<ReturnType<typeof projectIssueLink>>,
    host: string | undefined,
    scope: string
  ) {
    const { repos = [], workItemsCache } = this.store.getState()
    const identity = `${githubRepoIdentityKey(link.slug)}\0issue:${link.number}`
    const owners = new Map<string, { repo: Repo; address?: GitHubWorkItem }>()
    const add = (repo: Repo | undefined, address?: GitHubWorkItem) => {
      if (repo && !owners.get(bindingKey(repo))?.address) {
        owners.set(bindingKey(repo), { repo, address })
      }
    }
    for (const repo of lookupReposBySlugFromCache(
      repos,
      `${link.slug.owner}/${link.slug.repo}`,
      host
    )) {
      add(repo)
    }
    for (const record of this.records.values()) {
      const { hostId, repoId } = record.binding.observation
      if (this.current(record.binding) && githubTaskIdentity(record.address) === identity) {
        add(
          repos.find((r) => r.id === repoId && getRepoExecutionHostId(r) === hostId),
          record.address
        )
      }
    }
    for (const entry of Object.values(workItemsCache)) {
      for (const item of entry?.data ?? []) {
        if (item.type === 'issue' && githubTaskIdentity(item) === identity) {
          add(getWorkItemRepo(repos, item), item)
        }
      }
    }
    return [...owners.values()].flatMap(({ repo, address }) => {
      const binding = getRepoExecutionHostId(repo) === scope ? this.capture(repo) : undefined
      const item = address ?? buildProjectWorkItem(row, repo, host)
      // A binding known to lack the item route keeps main's board-only edit; a live owner still drains.
      return binding && item && this.canTrack(binding, item) ? [{ address: item, binding }] : []
    })
  }
  /** Matching records per Project row: execution source, GitHub host, owner/repo and issue number. */
  protected projectRecords(table: GitHubProjectTable, scope: string) {
    const groups = new Map<string, AcceptedTask[]>()
    for (const record of this.records.values()) {
      if (record.binding.observation.hostId === scope && this.current(record.binding)) {
        const key = githubTaskIdentity(record.address)
        groups.set(key, [...(groups.get(key) ?? []), record])
      }
    }
    return (row: GitHubProjectRow) => {
      const link = projectIssueLink(row, table.project.host)
      if (!link) {
        return []
      }
      const key = `${githubRepoIdentityKey(link.slug)}\0issue:${link.number}`
      return [...(groups.get(key) ?? [])].sort(newestFirst)
    }
  }
  /** Project rows are partial and unversioned: a conflict only triggers verification, never acceptance. */
  observeProject(table: GitHubProjectTable, target: RuntimeClientTarget) {
    if (!this.records.size) {
      return
    }
    const matchesFor = this.projectRecords(table, projectViewSourceScope(target))
    for (const row of table.rows) {
      const matches = matchesFor(row)
      const item = matches.find((match) => match.visible)?.visible
      const users = item?.assignees?.map((user) => login(user.login))
      const conflict =
        item &&
        (row.content.title !== item.title ||
          row.content.state?.toLowerCase() !== item.state ||
          projectListConflicts(
            row.content.labels.map((label) => label.name),
            item.labels,
            PROJECT_LABEL_LIMIT
          ) ||
          (!!users &&
            projectListConflicts(
              row.content.assignees.map((user) => login(user.login)),
              users,
              PROJECT_ASSIGNEE_LIMIT
            )))
      for (const candidate of matches) {
        if (conflict) {
          candidate.needsRead = true
        }
        if (conflict && candidate.failedAt === undefined) {
          void this.verify(candidate)
        }
      }
    }
    // A board fetch is an external delivery for every binding on its source.
    const scope = projectViewSourceScope(target)
    for (const incarnation of new Set(
      [...this.records.values()]
        .filter((record) => record.binding.observation.hostId === scope)
        .map((record) => record.binding.incarnation)
    )) {
      this.wake(incarnation)
    }
  }
  /** Publish only title, state and label/assignee membership; board fields and profiles stay the row's. */
  projectTable(table: GitHubProjectTable, scope: string): GitHubProjectTable {
    if (!this.records.size) {
      return table
    }
    const matchesFor = this.projectRecords(table, scope)
    let changed = false
    const rows = table.rows.map((row) => {
      const matches = matchesFor(row)
      if (!matches.length) {
        return row
      }
      // The newest accepted reading wins; owners without one add only their own edits.
      let item: TaskFacts = matches.find((match) => match.visible)?.visible ?? projectRowFacts(row)
      for (const match of matches) {
        item = match.base ? item : contribute(item, match)
      }
      const next = patchGitHubProjectRowContent(row, {
        title: item.title,
        state: item.state,
        labels: projectList(
          row.content.labels.map((label) => label.name),
          item.labels,
          PROJECT_LABEL_LIMIT
        ),
        ...(item.assignees === undefined
          ? {}
          : {
              assignees: projectList(
                row.content.assignees.map((user) => user.login),
                item.assignees.map((user) => user.login),
                PROJECT_ASSIGNEE_LIMIT,
                login
              )
            })
      })
      if (structuralValuesEqual(row, next)) {
        return row
      }
      changed = true
      return next
    })
    return changed ? { ...table, rows } : table
  }
}

export function createGitHubTaskRecordCache(store: StoreApi<AppState>) {
  const cache = new GitHubTaskRecordCache(store)
  store.subscribe((state, previous) => {
    if (
      state.repos !== previous.repos ||
      state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId ||
      state.runtimeEnvironments !== previous.runtimeEnvironments ||
      state.sshConnectionStates !== previous.sshConnectionStates ||
      state.sshStateByEnvironment !== previous.sshStateByEnvironment
    ) {
      cache.syncBindings(state.repos ?? [])
    }
  })
  return cache
}
