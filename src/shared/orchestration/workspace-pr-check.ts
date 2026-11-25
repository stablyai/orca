import { possibleWorkspacePrRepositories } from './workspace-pr-coverage'
import type { Repo } from '../repository/repo-types'
import type { WorktreeMeta } from '../worktree/meta-types'
import type { WorkspaceLineage, WorktreeLineage } from '../worktree/lineage-types'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import type { decodeLineageUncertaintyKey } from '../worktree/lineage/lineage-uncertainty'
import { getRepoExecutionHostId } from '../execution-host/execution-host'
import { lineageNodeProject, type LineageChildIndex } from './lineage-child-index'
import {
  specNamesPr,
  boundedUtf8,
  refKey,
  repoKey,
  scanPrRefs,
  type PullRequestRef
} from './workspace-pr-refs'

export type WorkspaceCheck = {
  version: 1
  state: 'complete' | 'partial' | 'skipped'
  outside: PullRequestRef[]
}
export type WorkspacePrSnapshot = {
  repos: readonly Repo[]
  metadata: (id: string, host: string) => Pick<WorktreeMeta, 'instanceId' | 'hostId'> | undefined
  lineage: Readonly<Record<string, WorktreeLineage>>
  workspaceLineage: Readonly<Record<string, WorkspaceLineage>>
  crossStoreLineage: Readonly<Record<string, unknown>>
  /** Store-kept grouping of the three lineage records' keys, built at most `limit` keys deep and
   *  requested only when a negative check must walk lineage; used only for those exact objects. */
  childIndex?: (limit: number) => LineageChildIndex
  uncertainty: unknown
  decodeUncertaintyKey?: typeof decodeLineageUncertaintyKey
  folders: readonly FolderWorkspace[]
  folderHost?: (folder: FolderWorkspace) => string | undefined
  primaries: readonly string[]
  incomplete?: boolean
}

export function checkWorkspacePullRequests(
  input: WorkspacePrSnapshot,
  report: { subject: string; body: string; spec: string; host: string }
): WorkspaceCheck {
  const result: WorkspaceCheck = { version: 1, state: 'complete', outside: [] }
  const partial = () => {
    result.state = 'partial'
  }
  const repos = new Map<string, Repo[]>()
  let incomplete = input.incomplete === true
  let count = 0
  for (const repo of input.repos) {
    if (++count > 200) {
      incomplete = true
      break
    }
    const rows = repos.get(repo.id) ?? []
    rows.push(repo)
    repos.set(repo.id, rows)
  }
  const identityCache = new Map<string, Set<string> | undefined>()
  const identities = (id: string): Set<string> | undefined => {
    if (identityCache.has(id)) {
      return identityCache.get(id)
    }
    const value = resolveIdentities(id)
    identityCache.set(id, value)
    return value
  }
  const resolveIdentities = (id: string): Set<string> | undefined => {
    const rows = repos.get(id)?.filter((repo) => getRepoExecutionHostId(repo) === report.host)
    if (!rows || rows.length !== 1) {
      return undefined
    }
    const repo = rows[0]!
    if (repo.kind === 'folder') {
      return new Set()
    }
    if (repo.gitRemoteIdentity === undefined) {
      return undefined
    }
    const ids = new Set<string>()
    if (repo.gitRemoteIdentity) {
      const key = repo.gitRemoteIdentity.canonicalKey.toLowerCase().replace(/\.git$/, '')
      ids.add(key)
      if (repo.upstream) {
        ids.add(
          `github.com/${repo.upstream.owner.toLowerCase()}/${repo.upstream.repo.toLowerCase()}`
        )
      }
    } else if (repo.upstream) {
      return undefined
    }
    return ids
  }
  const hostRepos = new Set<string>(),
    hosts = new Set(['github.com'])
  for (const [id, rows] of repos) {
    if (!rows.some((repo) => getRepoExecutionHostId(repo) === report.host)) {
      continue
    }
    const projectIdentities = identities(id)
    for (const key of projectIdentities ?? []) {
      hostRepos.add(key)
      const slash = key.indexOf('/')
      hosts.add(slash === -1 ? key : key.slice(0, slash))
    }
  }
  const projectOf = lineageNodeProject
  const primaryRepos = new Set<string>()
  for (const id of input.primaries) {
    const project = projectOf(id)
    if (!project) {
      continue
    }
    const ids = identities(project)
    if (!ids) {
      incomplete = true
    }
    for (const key of ids ?? []) {
      primaryRepos.add(key)
    }
  }
  const primaryHosts = new Set([...primaryRepos].map((key) => key.split('/')[0]!))
  const defaultHost = primaryHosts.size === 1 ? [...primaryHosts][0] : undefined
  const cappedSubject = boundedUtf8(report.subject, 16384)
  const subjectBytes = new TextEncoder().encode(cappedSubject.text).length
  const body = boundedUtf8(report.body, Math.max(0, 16384 - subjectBytes - 1))
  const text = `${
    cappedSubject.truncated ? cappedSubject.text.replace(/\S+$/, '') : cappedSubject.text
  }\n${body.truncated ? body.text.replace(/\S+$/, '') : body.text}`
  const refs: PullRequestRef[] = [],
    seenRefs = new Set<string>()
  for (const ref of scanPrRefs(text, defaultHost, hosts)) {
    if (ref === 'unknown-host') {
      partial()
      continue
    }
    if (typeof ref === 'number' || seenRefs.has(refKey(ref))) {
      continue
    }
    seenRefs.add(refKey(ref))
    refs.push(ref)
    if (refs.length === 5) {
      break
    }
  }
  if (!refs.length) {
    return result
  }
  const spec = boundedUtf8(report.spec, 65536)
  const specText = spec.truncated ? spec.text.replace(/\S+$/, '') : spec.text
  const given = new Set<string>(),
    unknownSpec = new Set<string>()
  for (const ref of refs) {
    const match = specNamesPr(specText, ref, defaultHost, { hostRepos, primaryRepos })
    if (match === true) {
      given.add(refKey(ref))
    } else if (match === 'unknown') {
      unknownSpec.add(refKey(ref))
    }
  }
  // A clipped final token cannot establish a negative spec match.
  if (cappedSubject.truncated || body.truncated) {
    partial()
  }
  const interested = new Set(
    refs
      .filter(
        (ref) =>
          !given.has(refKey(ref)) && !primaryRepos.has(repoKey(ref)) && hostRepos.has(repoKey(ref))
      )
      .map(repoKey)
  )
  if (interested.size === 0) {
    if (
      refs.some(
        (ref) =>
          !given.has(refKey(ref)) && !primaryRepos.has(repoKey(ref)) && !hostRepos.has(repoKey(ref))
      )
    ) {
      partial()
    }
    return result
  }
  const coverage = possibleWorkspacePrRepositories(
    input,
    report.host,
    repos,
    identities,
    projectOf,
    interested
  )
  incomplete ||= coverage.incomplete
  for (const ref of refs) {
    const key = repoKey(ref)
    if (given.has(refKey(ref)) || primaryRepos.has(key)) {
      continue
    }
    if (
      coverage.candidateRepos.has(key) ||
      incomplete ||
      spec.truncated ||
      unknownSpec.has(refKey(ref))
    ) {
      partial()
    } else if (hostRepos.has(key)) {
      result.outside.push(ref)
    } else {
      partial()
    }
  }
  return result
}
