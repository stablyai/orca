import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearWorkspace } from '../../../../../shared/linear/workspace-types'
import type { LinearReadScope } from './linear-slice-scope'
import type { LinearIssueData } from './linear-issue-read'
import {
  knownLinearOrganization,
  pendingLinearIssueWrites,
  projectLinearIssue,
  type IssueOwner
} from './linear-issue-write-publication'

export function rows(data: LinearIssueData): LinearIssue[] {
  return data === null ? [] : Array.isArray(data) ? data : 'items' in data ? data.items : [data]
}
export function replaceRows<T extends LinearIssueData>(data: T, items: LinearIssue[]): T {
  // SAFETY: the adapter preserves the exact input container shape.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the adapter preserves the input container family; generic T cannot be narrowed by its runtime array/items/null discriminant.
  return (
    data === null
      ? (items[0] ?? null)
      : Array.isArray(data)
        ? items
        : 'items' in data
          ? { ...data, items }
          : (items[0] ?? null)
  ) as T
}
function occurrence(issue: LinearIssue) {
  return JSON.stringify([issue.workspaceId, issue.id])
}

export function createLinearIssueReconciler<T extends LinearIssueData>(
  args: {
    scope: LinearReadScope
    workspaces?: LinearWorkspace[]
    workspaceId?: string | null
    identifier?: string
  },
  currentData: () => T | null
) {
  const organizations = new Map(
    args.workspaces?.map((workspace) => [workspace.id, knownLinearOrganization(workspace)])
  )
  const queryOrg = args.workspaceId ? organizations.get(args.workspaceId) : undefined
  const knownId = () => (args.identifier ? rows(currentData())[0]?.id : undefined)
  const compatible = (owner: IssueOwner) => {
    const detailId = knownId()
    if (detailId) {
      return owner.id === detailId
    }
    if (args.identifier && owner.id === args.identifier) {
      return true
    }
    const ownerOrg =
      owner.organizationId ?? (owner.workspaceId ? organizations.get(owner.workspaceId) : undefined)
    return !queryOrg || !ownerOrg || queryOrg === ownerOrg
  }
  function* candidates(): Generator<IssueOwner> {
    const all = pendingLinearIssueWrites.get(args.scope.contextKey)
    const detailId = knownId()
    if (detailId) {
      const owner = all?.get(detailId)
      if (owner) {
        yield owner
      }
    } else if (all) {
      for (const owner of all.values()) {
        if (compatible(owner)) {
          yield owner
        }
      }
    }
  }
  const hasCandidates = () => !candidates().next().done
  const reconcile = (data: T | null): T | null => {
    const pending = [...candidates()]
    if (!pending.length) {
      return data
    }
    const returned = rows(data)
    if (args.identifier && returned.length) {
      return replaceRows(
        data,
        returned.map((row) => projectLinearIssue(args.scope, row))
      )
    }
    const present = new Set(returned.map(occurrence))
    const previous = rows(currentData())
    const protectedMissing = previous.filter(
      (row) =>
        !present.has(occurrence(row)) &&
        pendingLinearIssueWrites.get(args.scope.contextKey)?.has(row.id)
    )
    const known = new Set([...returned, ...previous].map((row) => row.id))
    const uncertain = pending.some((owner) => !known.has(owner.id))
    if (uncertain && !(data && !Array.isArray(data) && 'errors' in data && data.errors?.length)) {
      return null
    }
    const projected = returned.map((row) => projectLinearIssue(args.scope, row))
    if (!protectedMissing.length) {
      return replaceRows(data, projected)
    }
    const missing = new Set(protectedMissing)
    const merged: LinearIssue[] = []
    let next = 0
    for (let i = 0; i < previous.length && (next < projected.length || missing.size); i++) {
      const prior = previous[i]
      if (missing.delete(prior)) {
        merged.push(projectLinearIssue(args.scope, prior))
      } else if (next < projected.length) {
        merged.push(projected[next++])
      }
    }
    merged.push(...projected.slice(next))
    return replaceRows(data ?? currentData(), merged)
  }
  return { organizations, queryOrg, compatible, hasCandidates, reconcile }
}
