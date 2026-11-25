import { worktreeWorkspaceKey } from '../workspace/identity/workspace-scope'
import { getRepoExecutionHostId } from '../execution-host/execution-host'
import {
  decodeLineageUncertaintyKey,
  isLineageUncertaintyMap,
  LINEAGE_SCAN_ROW_LIMIT
} from '../worktree/lineage/lineage-uncertainty'
import type { Repo } from '../repository/repo-types'
import type { WorkspacePrSnapshot } from './workspace-pr-check'
import { indexMatchesRecords, lineageRecordNode } from './lineage-child-index'

type Edge = { parent: string }

export function possibleWorkspacePrRepositories(
  input: WorkspacePrSnapshot,
  host: string,
  repos: Map<string, Repo[]>,
  identities: (id: string) => Set<string> | undefined,
  projectOf: (id: string) => string | undefined,
  interested: ReadonlySet<string>
) {
  let incomplete = false,
    rawRows = 0,
    hasCanonical = false,
    hasCross = false
  const candidateRepos = new Set<string>(),
    markers = new Set<string>()
  const nodeKey = (key: string) => (key.startsWith('worktree:') ? key.slice(9) : key)
  const primaries = new Set(input.primaries.map(nodeKey))
  const state = input.uncertainty
  const markerRows = isLineageUncertaintyMap(state) ? state : {}
  for (const _key in input.workspaceLineage) {
    hasCanonical = true
    break
  }
  for (const _key in input.crossStoreLineage) {
    hasCross = true
    break
  }
  const admit = () => {
    if (++rawRows <= LINEAGE_SCAN_ROW_LIMIT) {
      return true
    }
    incomplete = true
    return false
  }
  if (state !== undefined && !isLineageUncertaintyMap(state)) {
    incomplete = true
  }
  const markedProjects = new Set<string>()
  for (const key in markerRows) {
    if (!admit()) {
      break
    }
    const decoded = (input.decodeUncertaintyKey ?? decodeLineageUncertaintyKey)(key)
    if (!decoded || markerRows[key] !== true) {
      incomplete = true
      continue
    }
    const { host: markerHost, child, node, project } = decoded
    if (markerHost !== null && markerHost !== host) {
      continue
    }
    if (!child || !node) {
      incomplete = true
    } else {
      if (project && !markedProjects.has(project)) {
        markedProjects.add(project)
        const ids = identities(project)
        if (!ids) {
          return { candidateRepos, incomplete: true }
        }
        for (const id of ids) {
          if (interested.has(id)) {
            candidateRepos.add(id)
          }
        }
        if (candidateRepos.size === interested.size) {
          return { candidateRepos, incomplete }
        }
      } else if (!project && !node.startsWith('folder:')) {
        return { candidateRepos, incomplete: true }
      }
      markers.add(node)
    }
  }
  if (input.folders.length + input.repos.length > 200) {
    incomplete = true
  }
  const folders = new Map(
    input.folders
      .slice(0, Math.max(0, 200 - input.repos.length))
      .map((folder) => [`folder:${folder.id}`, folder])
  )
  if (incomplete) {
    return { candidateRepos, incomplete }
  }
  const memo = new Map<string, boolean | 'visiting'>()
  const path: string[] = []
  const meta = (key: string) => (key.startsWith('folder:') ? undefined : input.metadata(key, host))
  const parentInstances = new Map<string, string | undefined>()
  const parentInstanceOf = (key: string) => {
    const cached = parentInstances.get(key)
    if (cached !== undefined || parentInstances.has(key)) {
      return cached
    }
    const instance = meta(key)?.instanceId
    parentInstances.set(key, instance)
    return instance
  }
  const edgeOf = (key: string): Edge | boolean | undefined => {
    const canonicalKey =
      hasCanonical || hasCross ? (key.startsWith('folder:') ? key : worktreeWorkspaceKey(key)) : ''
    if (hasCross && Object.hasOwn(input.crossStoreLineage, canonicalKey)) {
      return true
    }
    const raw = key.startsWith('folder:') ? undefined : input.lineage[key]
    const row = hasCanonical ? input.workspaceLineage[canonicalKey] : undefined
    if ((raw && raw.worktreeId !== key) || (row && row.childWorkspaceKey !== canonicalKey)) {
      return true
    }
    if (!raw && !row) {
      return (hasCanonical && Object.hasOwn(input.workspaceLineage, canonicalKey)) ||
        Object.hasOwn(input.lineage, key)
        ? true
        : undefined
    }
    if (
      raw &&
      row &&
      (raw.parentWorktreeId !== nodeKey(row.parentWorkspaceKey) ||
        raw.worktreeInstanceId !== row.childInstanceId ||
        raw.parentWorktreeInstanceId !== row.parentInstanceId)
    ) {
      return true
    }
    const parent = row ? nodeKey(row.parentWorkspaceKey) : raw!.parentWorktreeId
    const childInstance = row ? row.childInstanceId : raw!.worktreeInstanceId
    const parentInstance = row ? row.parentInstanceId : raw!.parentWorktreeInstanceId
    const cm = meta(key)
    if (!cm || !childInstance || cm.instanceId !== childInstance) {
      return true
    }
    if (parent.startsWith('folder:')) {
      const folder = folders.get(parent)
      if (
        !folder ||
        folder.isArchived ||
        !parentInstance ||
        parentInstance !== folder.id ||
        (input.folderHost && input.folderHost(folder) !== host)
      ) {
        return true
      }
    } else if (!parentInstance || parentInstanceOf(parent) !== parentInstance) {
      return true
    }
    const knownParent = memo.get(parent)
    return typeof knownParent === 'boolean' ? knownParent : { parent }
  }
  // Memoized parent walks inspect only ancestors that could affect the reported repositories.
  const possible = (child: string): boolean => {
    if (primaries.has(child) || markers.has(child)) {
      return true
    }
    const first = edgeOf(child)
    if (typeof first === 'boolean') {
      return first
    }
    if (!first) {
      return false
    }
    path.length = 0
    let cursor = child,
      answer = false
    while (true) {
      if (primaries.has(cursor) || markers.has(cursor)) {
        answer = true
        break
      }
      const known = memo.get(cursor)
      if (known !== undefined) {
        answer = known === 'visiting' || known
        break
      }
      memo.set(cursor, 'visiting')
      path.push(cursor)
      const edge = cursor === child ? first : edgeOf(cursor)
      if (typeof edge === 'boolean') {
        answer = edge
        break
      }
      if (!edge) {
        break
      }
      cursor = edge.parent
    }
    for (const key of path) {
      memo.set(key, answer)
    }
    return answer
  }
  const relevantProjects = new Map<string, boolean>()
  const relevant = (project: string): boolean => {
    let answer = relevantProjects.get(project)
    if (answer === undefined) {
      const owners = repos.get(project)
      answer = !owners || owners.some((repo) => getRepoExecutionHostId(repo) === host)
      if (answer) {
        const ids = identities(project)
        answer = !ids || [...ids].some((id) => interested.has(id))
      }
      relevantProjects.set(project, answer)
    }
    return answer
  }
  const consider = (child: string, project: string | undefined) => {
    if (!project) {
      if (!child.startsWith('folder:')) {
        incomplete = true
      }
      return
    }
    if (!relevant(project) || !possible(child)) {
      return
    }
    const ids = identities(project)
    if (!ids) {
      incomplete = true
    }
    for (const key of ids ?? []) {
      if (interested.has(key)) {
        candidateRepos.add(key)
      }
    }
  }
  const records = [input.lineage, input.workspaceLineage, input.crossStoreLineage] as const
  // Built only now, after the marker scan, within the rows the markers left.
  const index = input.childIndex?.(LINEAGE_SCAN_ROW_LIMIT - rawRows)
  if (indexMatchesRecords(index, records)) {
    // Every indexed key counts toward the same row limit a full scan applies; an overflow always does.
    if (index.overflow || rawRows + index.size > LINEAGE_SCAN_ROW_LIMIT) {
      return { candidateRepos, incomplete: true }
    }
    for (let i = 0; i < records.length; i++) {
      for (const key of index.unprojected[i]!) {
        consider(lineageRecordNode(i, key), undefined)
      }
      // Only relevant projects' children are walked. A key deleted since indexing reads as no edge
      // here, the same answer its own record gives, so it cannot add or hide a candidate.
      for (const [project, keys] of index.byProject[i]!) {
        if (!relevant(project)) {
          continue
        }
        for (const key of keys) {
          consider(lineageRecordNode(i, key), project)
          if (candidateRepos.size === interested.size) {
            return { candidateRepos, incomplete }
          }
        }
      }
    }
    return { candidateRepos, incomplete }
  }
  for (let i = 0; i < records.length; i++) {
    for (const child in records[i]) {
      if (!admit()) {
        return { candidateRepos, incomplete }
      }
      const node = lineageRecordNode(i, child)
      consider(node, projectOf(node))
      if (candidateRepos.size === interested.size) {
        return { candidateRepos, incomplete }
      }
    }
  }
  return { candidateRepos, incomplete }
}
