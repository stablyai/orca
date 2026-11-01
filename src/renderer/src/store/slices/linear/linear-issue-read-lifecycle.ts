import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearReadScope } from './linear-slice-scope'

export type LinearIssueView<T> =
  | { kind: 'loading'; data: T | null }
  | { kind: 'data'; data: T | null }
  | { kind: 'error'; error: unknown; data: T | null }
  | { kind: 'abandoned'; data: null }
export type LinearIssueLease<T> = {
  currentView: () => LinearIssueView<T>
  subscribe: (notify: () => void) => () => void
  commit: <S>(
    view: LinearIssueView<T>,
    previous: S,
    reduce: (previous: S, data: T | null) => S
  ) => S
  waitForCurrentTerminal: () => Promise<LinearIssueView<T>>
  release: () => void
}
export type LinearIssueRead<T> = { acquire: (isLive?: () => boolean) => LinearIssueLease<T> }
export type LinearIssueRequest<T> = LinearIssueRead<T> & {
  force: () => void
  abandon: () => void
  contextKey: string
}

export type IssueReadLifecycle = {
  scope: LinearReadScope
  edge: (id: string, confirmed?: boolean) => void
  patch: (id: string, patch: Partial<LinearIssue>) => void
  drain: () => void
  invalidate: (
    identifier?: string,
    workspaceId?: string | null,
    affectedWorkspaces?: ReadonlySet<string>
  ) => void
  abandon: () => void
}
export const reads = new Map<string, Set<IssueReadLifecycle>>()
export function scopedReads(scope: LinearReadScope) {
  return reads.get(scope.contextKey) ?? []
}
export function notifyPublication(publish: () => void) {
  try {
    publish()
  } catch (error) {
    console.warn('[linear] issue publication failed:', error)
  }
}
export function abandonLinearIssueReads() {
  // oxlint-disable-next-line unicorn/no-useless-spread -- Why: callbacks can synchronously register replacement scopes.
  for (const scoped of [...reads.values()]) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- Why: callbacks can synchronously register replacement demand.
    for (const read of [...scoped]) {
      read.abandon()
    }
  }
}

export function publishLinearIssuePatch(
  scope: LinearReadScope,
  id: string,
  patch: Partial<LinearIssue>
) {
  for (const read of scopedReads(scope)) {
    read.patch(id, patch)
  }
}

export function invalidateLinearIssueReads(
  scope: LinearReadScope,
  identifier?: string,
  allSources = false,
  workspaceId?: string | null,
  affectedWorkspaces?: ReadonlySet<string>
) {
  const affected = allSources
    ? [...reads.values()].filter(
        (scoped) =>
          scoped.values().next().value?.scope.runtimeContextKey === scope.runtimeContextKey
      )
    : [scopedReads(scope)]
  for (const scoped of affected) {
    // oxlint-disable-next-line unicorn/no-useless-spread -- Why: refresh callbacks can replace demand.
    for (const read of [...scoped]) {
      read.invalidate(identifier, workspaceId, affectedWorkspaces)
    }
  }
}

export function observeLinearIssueRead<T>(
  read: LinearIssueRead<T>,
  isLive: () => boolean,
  publish: (lease: LinearIssueLease<T>, view: LinearIssueView<T>) => void
): () => void {
  const lease = read.acquire(isLive)
  const update = () => publish(lease, lease.currentView())
  const unsubscribe = lease.subscribe(update)
  update()
  return () => {
    unsubscribe()
    lease.release()
  }
}

export async function consumeLinearIssueRead<T>(
  read: LinearIssueRead<T>,
  isLive = () => true,
  consume?: (data: T | null, lease: LinearIssueLease<T>, view: LinearIssueView<T>) => void,
  signal?: AbortSignal
): Promise<void> {
  const lease = read.acquire(() => !signal?.aborted && isLive())
  const abort = () => lease.release()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const view = await lease.waitForCurrentTerminal()
    if (view.kind === 'abandoned') {
      return
    }
    if (view.kind === 'error') {
      throw view.error
    }
    lease.commit(view, undefined, () => {
      consume?.(view.data, lease, view)
      return undefined
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    lease.release()
  }
}

export function mapLinearIssueRead<T, U>(
  read: LinearIssueRead<T>,
  map: (data: T | null) => U,
  onError?: (error: unknown) => U
): LinearIssueRead<U> {
  return {
    acquire: (isLive) => {
      const lease = read.acquire(isLive)
      let original: LinearIssueView<T> | undefined
      let mapped: LinearIssueView<U> = { kind: 'abandoned', data: null }
      const currentView = (): LinearIssueView<U> => {
        const next = lease.currentView()
        if (original !== next) {
          original = next
          mapped =
            next.kind === 'abandoned'
              ? next
              : next.kind === 'error' && onError
                ? { kind: 'data', data: onError(next.error) }
                : next.kind === 'data'
                  ? { kind: 'data', data: map(next.data) }
                  : { ...next, data: next.data === null ? null : map(next.data) }
        }
        return mapped
      }
      return {
        currentView,
        subscribe: lease.subscribe,
        release: lease.release,
        commit: (view, previous, reduce) =>
          view === currentView() && original
            ? lease.commit(original, previous, () => reduce(previous, view.data))
            : previous,
        waitForCurrentTerminal: async () => {
          await lease.waitForCurrentTerminal()
          while (currentView().kind === 'loading') {
            await lease.waitForCurrentTerminal()
          }
          return currentView()
        }
      }
    }
  }
}
