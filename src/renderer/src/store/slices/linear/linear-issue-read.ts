import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type {
  LinearCollectionResult,
  LinearWorkspace
} from '../../../../../shared/linear/workspace-types'
import type { LinearReadScope } from './linear-slice-scope'
import {
  reads,
  notifyPublication,
  type LinearIssueRead,
  type LinearIssueView,
  type LinearIssueLease
} from './linear-issue-read-lifecycle'
import { pendingLinearIssueWrites, projectLinearIssue } from './linear-issue-write-publication'
import { createLinearIssueReconciler, rows, replaceRows } from './linear-issue-read-reconciliation'

export type LinearIssueData =
  | LinearIssue
  | null
  | LinearIssue[]
  | LinearCollectionResult<LinearIssue>
export function openLinearIssueRead<T extends LinearIssueData>(args: {
  scope: LinearReadScope
  workspaceId?: string | null
  identifier?: string
  workspaces?: LinearWorkspace[]
  seed: T | null
  cached?: T | null
  dispatch: (force: boolean) => Promise<T>
  publish: (data: T) => void
  isCurrent: () => boolean
  remove: () => void
  onSettled?: (data: T | undefined, error?: unknown) => void
}): LinearIssueRead<T> & { force: () => void; abandon: () => void; contextKey: string } {
  let view: LinearIssueView<T> = { kind: 'loading', data: args.seed }
  let warm = args.seed
  let attempt: object | null = null
  let active = true
  let needsReplacement = false
  const consumers = new Map<() => void, () => boolean>()
  const notify = () => {
    // oxlint-disable-next-line unicorn/no-useless-spread -- Why: callbacks can release or acquire demand during notification.
    for (const listener of [...consumers.keys()]) {
      notifyPublication(listener)
    }
  }
  const { organizations, queryOrg, compatible, hasCandidates, reconcile } =
    createLinearIssueReconciler(args, () => warm)
  const abandon = () => {
    if (!active) {
      return
    }
    active = false
    attempt = null
    view = { kind: 'abandoned', data: null }
    const scoped = reads.get(args.scope.contextKey)
    scoped?.delete(lifecycle)
    if (!scoped?.size) {
      reads.delete(args.scope.contextKey)
    }
    args.remove()
    notify()
  }
  const start = (force = true) => {
    if (!active || !args.isCurrent()) {
      abandon()
      return
    }
    const token = {}
    attempt = token
    needsReplacement = false
    view = { kind: 'loading', data: warm }
    notify()
    void args.dispatch(force).then(
      (data) => {
        if (!active || attempt !== token) {
          return
        }
        if (!args.isCurrent()) {
          abandon()
          return
        }
        const reconciled = reconcile(data)
        attempt = null
        if (reconciled === null && hasCandidates()) {
          needsReplacement = true
          view = { kind: 'loading', data: warm }
          notify()
          return
        }
        const published = reconciled ?? data
        warm = published
        needsReplacement = hasCandidates()
        view = { kind: 'data', data: published }
        notifyPublication(() => args.publish(published))
        notify()
        notifyPublication(() => args.onSettled?.(published))
      },
      (error: unknown) => {
        if (!active || attempt !== token) {
          return
        }
        if (!args.isCurrent()) {
          abandon()
          return
        }
        attempt = null
        needsReplacement = false
        view = { kind: 'error', error, data: warm }
        notify()
        notifyPublication(() => args.onSettled?.(undefined, error))
      }
    )
  }
  const lifecycle = {
    scope: args.scope,
    patch: (id: string, patch: Partial<LinearIssue>) => {
      if (view.kind === 'abandoned' || warm === null || !rows(warm).some((row) => row.id === id)) {
        return
      }
      warm = replaceRows(
        warm,
        rows(warm).map((row) => (row.id === id ? { ...row, ...patch } : row))
      )
      view = { ...view, data: warm }
      notify()
    },
    edge: (id: string, confirmed = false) => {
      if (!active) {
        return
      }
      if (confirmed) {
        const known = args.identifier ? rows(warm)[0] : undefined
        if (known && known.id !== id) {
          return
        }
      } else {
        const owner = pendingLinearIssueWrites.get(args.scope.contextKey)?.get(id)
        if (!owner || !compatible(owner)) {
          return
        }
      }
      attempt = null
      needsReplacement = true
      if (warm !== null) {
        warm = replaceRows(
          warm,
          rows(warm).map((row) => projectLinearIssue(args.scope, row))
        )
      }
      view =
        warm !== null
          ? view.kind === 'error'
            ? { ...view, data: warm }
            : { kind: 'data', data: warm }
          : { kind: 'loading', data: null }
      notify()
    },
    drain: () => {
      if (needsReplacement && !hasCandidates()) {
        if ([...consumers.values()].some((current) => current())) {
          start()
        } else {
          abandon()
        }
      }
    },
    invalidate: (
      identifier?: string,
      workspaceId?: string | null,
      affectedWorkspaces?: ReadonlySet<string>
    ) => {
      if (
        affectedWorkspaces &&
        args.workspaceId !== 'all' &&
        !affectedWorkspaces.has(args.workspaceId ?? 'default') &&
        !(args.workspaceId == null && affectedWorkspaces.has('selected'))
      ) {
        return
      }
      if (identifier && args.identifier) {
        // Cold equal lookups can be affected too; the exact detail is forced by its caller.
        const organization = workspaceId ? organizations.get(workspaceId) : undefined
        if (
          (args.identifier === identifier &&
            (args.workspaceId ?? null) === (workspaceId ?? null)) ||
          (queryOrg && organization && queryOrg !== organization) ||
          (args.identifier !== identifier &&
            !rows(warm).some((row) => row.id === identifier || row.identifier === identifier))
        ) {
          return
        }
      }
      if ([...consumers.values()].some((current) => current())) {
        start()
      } else {
        abandon()
      }
    },
    abandon
  }
  let scoped = reads.get(args.scope.contextKey)
  if (!scoped) {
    scoped = new Set()
    reads.set(args.scope.contextKey, scoped)
  }
  scoped.add(lifecycle)
  const read = {
    contextKey: args.scope.contextKey,
    force: start,
    abandon,
    acquire: (isLive = () => true): LinearIssueLease<T> => {
      let live = true
      const listeners = new Set<() => void>()
      const signal = () => {
        for (const listener of listeners) {
          notifyPublication(listener)
        }
      }
      const current = () => live && active && isLive() && args.isCurrent()
      consumers.set(signal, current)
      const lease: LinearIssueLease<T> = {
        currentView: () => (current() ? view : { kind: 'abandoned', data: null }),
        subscribe: (listener) => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        commit: (expected, previous, reduce) =>
          current() && view === expected ? reduce(previous, expected.data) : previous,
        waitForCurrentTerminal: () =>
          new Promise((resolve) => {
            const finish = () => {
              const latest = lease.currentView()
              if (latest.kind === 'loading') {
                return
              }
              listeners.delete(finish)
              resolve(latest)
            }
            listeners.add(finish)
            finish()
          }),
        release: () => {
          live = false
          signal()
          listeners.clear()
          consumers.delete(signal)
          if (!consumers.size) {
            abandon()
          }
        }
      }
      return lease
    }
  }
  if (args.cached === undefined) {
    start(false)
  } else {
    const reconciled = reconcile(args.cached)
    needsReplacement = hasCandidates()
    warm = reconciled ?? args.cached
    view =
      reconciled === null && needsReplacement
        ? { kind: 'loading', data: warm }
        : { kind: 'data', data: reconciled ?? args.cached }
  }
  return read
}
