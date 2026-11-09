// Share links per Orca Cloud environment, shared by the Ports panel section and the Share dialog so
// a link created in one shows up in the other without a second fetch.
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type {
  CloudShareFailureCode,
  CloudShareResult,
  ShareCreateRequest,
  ShareLink
} from '../../../../shared/hosted-sandbox/hosted-sandbox-share-wire'

export type CloudSharesState =
  /** Not asked yet: share UI stays hidden until the environment is known to be Orca Cloud. */
  | { status: 'unknown'; shares: [] }
  | { status: 'ready'; shares: ShareLink[] }
  | { status: 'error'; shares: ShareLink[]; code: CloudShareFailureCode }
  /** Not an Orca Cloud workspace (or no control plane in this build). */
  | { status: 'unsupported'; shares: [] }

const UNKNOWN: CloudSharesState = { status: 'unknown', shares: [] }
const states = new Map<string, CloudSharesState>()
/** Bumped by every local change, so a list answer that started earlier can't overwrite it. */
const versions = new Map<string, number>()
const inflight = new Map<string, Promise<void>>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function set(environmentId: string, state: CloudSharesState): void {
  states.set(environmentId, state)
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isCloudSharesAvailable(state: CloudSharesState): boolean {
  return state.status === 'ready' || state.status === 'error'
}

export function refreshCloudShares(environmentId: string): Promise<void> {
  const running = inflight.get(environmentId)
  if (running) {
    return running
  }
  const version = versions.get(environmentId) ?? 0
  let stale = false
  const work = window.api.cloudShares
    .list({ environmentId })
    .then((result) => {
      if ((versions.get(environmentId) ?? 0) !== version) {
        stale = true
        return
      }
      const previous = states.get(environmentId)
      if (result.ok) {
        set(environmentId, { status: 'ready', shares: result.shares })
      } else if (result.code === 'not_cloud') {
        set(environmentId, { status: 'unsupported', shares: [] })
      } else {
        set(environmentId, { status: 'error', shares: previous?.shares ?? [], code: result.code })
      }
    })
    .catch(() => {
      if ((versions.get(environmentId) ?? 0) !== version) {
        stale = true
        return
      }
      // Only a known cloud workspace shows the error; an unknown one stays hidden and retries later.
      const previous = states.get(environmentId)
      if (previous && isCloudSharesAvailable(previous)) {
        set(environmentId, { status: 'error', shares: previous.shares, code: 'unavailable' })
      }
    })
    .finally(() => inflight.delete(environmentId))
    // An answer that raced a local change is dropped; ask once more so Retry still refreshes.
    .then(() => (stale ? refreshCloudShares(environmentId) : undefined))
  inflight.set(environmentId, work)
  return work
}

/** New links go first; an updated one (revoked) keeps its place so the list doesn't jump. */
function upsert(environmentId: string, share: ShareLink): void {
  versions.set(environmentId, (versions.get(environmentId) ?? 0) + 1)
  const current = states.get(environmentId)?.shares ?? []
  const shares = current.some((item) => item.id === share.id)
    ? current.map((item) => (item.id === share.id ? share : item))
    : [share, ...current]
  set(environmentId, { status: 'ready', shares })
}

type Failure = { ok: false; code: CloudShareFailureCode; message: string }
const notCloud: Failure = { ok: false, code: 'not_cloud', message: '' }
const unreachable: Failure = { ok: false, code: 'unavailable', message: '' }

export type CloudSharesController = {
  state: CloudSharesState
  refresh: () => Promise<void>
  create: (request: ShareCreateRequest) => Promise<CloudShareResult<{ share: ShareLink }>>
  revoke: (shareId: string) => Promise<CloudShareResult<{ share: ShareLink }>>
  open: (shareId: string) => Promise<CloudShareResult<object>>
}

/** Loads once per environment (skipped once it is known not to be Orca Cloud). */
export function useCloudShares(environmentId: string | null): CloudSharesController {
  const state = useSyncExternalStore(subscribe, () =>
    environmentId ? (states.get(environmentId) ?? UNKNOWN) : UNKNOWN
  )
  useEffect(() => {
    if (environmentId && states.get(environmentId)?.status !== 'unsupported') {
      void refreshCloudShares(environmentId)
    }
  }, [environmentId])

  const refresh = useCallback(
    () => (environmentId ? refreshCloudShares(environmentId) : Promise.resolve()),
    [environmentId]
  )
  const create = useCallback(
    async (request: ShareCreateRequest) => {
      if (!environmentId) {
        return notCloud
      }
      const result = await window.api.cloudShares
        .create({ environmentId, request })
        .catch((): Failure => unreachable)
      if (result.ok) {
        upsert(environmentId, result.share)
      }
      return result
    },
    [environmentId]
  )
  const revoke = useCallback(
    async (shareId: string) => {
      if (!environmentId) {
        return notCloud
      }
      const result = await window.api.cloudShares
        .revoke({ environmentId, shareId })
        .catch((): Failure => unreachable)
      if (result.ok) {
        upsert(environmentId, result.share)
      }
      return result
    },
    [environmentId]
  )
  const open = useCallback(
    (shareId: string) =>
      environmentId
        ? window.api.cloudShares.open({ environmentId, shareId }).catch((): Failure => unreachable)
        : Promise.resolve(notCloud),
    [environmentId]
  )
  return { state, refresh, create, revoke, open }
}
