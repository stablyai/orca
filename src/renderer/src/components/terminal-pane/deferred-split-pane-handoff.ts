import type { PaneKey } from '../../../../shared/stable-pane-id'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  PTY_PRECONNECT_INPUT_MAX_CODE_UNITS,
  PTY_PRECONNECT_INPUT_MAX_ENTRIES
} from './pty-preconnect-input-buffer'
import type { PtyPreconnectInputEntry, PtyPreconnectInputKind } from './pty-preconnect-input-buffer'

export type DeferredSplitPaneInputKind = PtyPreconnectInputKind
export type DeferredSplitPaneInput = PtyPreconnectInputEntry

declare const deferredSplitPaneHandoffHandleBrand: unique symbol

export type DeferredSplitPaneHandoffHandle = {
  readonly [deferredSplitPaneHandoffHandleBrand]: true
}

export type ClaimedDeferredSplitPaneHandoff = {
  handle: DeferredSplitPaneHandoffHandle
  cwdPromise: Promise<string>
  preconnectInput: DeferredSplitPaneInput[]
}

export const DEFERRED_SPLIT_PANE_HANDOFF_TTL_MS = 15_000
export const DEFERRED_SPLIT_PANE_HANDOFF_MAX_RECORDS = 64

type DeferredSplitPaneHandoffRecord = {
  cwdPromise: Promise<string>
  expiresAtMs: number
  expiryTimer: ReturnType<typeof setTimeout>
  inputCodeUnits: number
  owner: DeferredSplitPaneHandoffHandle
  preconnectInput: DeferredSplitPaneInput[]
}

const handoffs = new Map<PaneKey, DeferredSplitPaneHandoffRecord>()
let keyByHandle = new WeakMap<DeferredSplitPaneHandoffHandle, PaneKey>()

function createHandle(key: PaneKey): DeferredSplitPaneHandoffHandle {
  const handle = {} as DeferredSplitPaneHandoffHandle
  keyByHandle.set(handle, key)
  return handle
}

function getOwnedRecord(
  handle: DeferredSplitPaneHandoffHandle
): { key: PaneKey; record: DeferredSplitPaneHandoffRecord } | null {
  const key = keyByHandle.get(handle)
  const record = key ? handoffs.get(key) : undefined
  if (!key || !record || record.owner !== handle) {
    return null
  }
  if (record.expiresAtMs <= Date.now()) {
    deleteHandoff(key, record)
    return null
  }
  return { key, record }
}

function deleteHandoff(key: PaneKey, expected?: DeferredSplitPaneHandoffRecord): void {
  const record = handoffs.get(key)
  if (!record || (expected && record !== expected)) {
    return
  }
  clearTimeout(record.expiryTimer)
  handoffs.delete(key)
}

function pruneExpiredHandoffs(nowMs: number): void {
  for (const [key, record] of handoffs) {
    if (record.expiresAtMs <= nowMs) {
      deleteHandoff(key, record)
    }
  }
}

export function beginDeferredSplitPaneHandoff(
  key: PaneKey,
  cwdPromise: Promise<string>
): DeferredSplitPaneHandoffHandle {
  const nowMs = Date.now()
  pruneExpiredHandoffs(nowMs)
  deleteHandoff(key)
  if (handoffs.size >= DEFERRED_SPLIT_PANE_HANDOFF_MAX_RECORDS) {
    const oldestKey = handoffs.keys().next().value
    if (oldestKey) {
      deleteHandoff(oldestKey)
    }
  }
  const owner = createHandle(key)
  const record: DeferredSplitPaneHandoffRecord = {
    cwdPromise,
    expiresAtMs: nowMs + DEFERRED_SPLIT_PANE_HANDOFF_TTL_MS,
    expiryTimer: setTimeout(() => {
      deleteHandoff(key, record)
    }, DEFERRED_SPLIT_PANE_HANDOFF_TTL_MS),
    inputCodeUnits: 0,
    owner,
    preconnectInput: []
  }
  record.expiryTimer.unref?.()
  handoffs.set(key, record)
  return owner
}

export function claimDeferredSplitPaneHandoff(
  key: PaneKey
): ClaimedDeferredSplitPaneHandoff | null {
  const record = handoffs.get(key)
  if (!record) {
    return null
  }
  if (record.expiresAtMs <= Date.now()) {
    deleteHandoff(key, record)
    return null
  }
  const owner = createHandle(key)
  record.owner = owner
  return {
    handle: owner,
    cwdPromise: record.cwdPromise,
    preconnectInput: record.preconnectInput.map((input) => ({ ...input }))
  }
}

export function appendDeferredSplitPaneInput(
  handle: DeferredSplitPaneHandoffHandle,
  input: DeferredSplitPaneInput
): void {
  const owned = getOwnedRecord(handle)
  if (
    !owned ||
    owned.record.preconnectInput.length >= PTY_PRECONNECT_INPUT_MAX_ENTRIES ||
    input.data.length > PTY_PRECONNECT_INPUT_MAX_CODE_UNITS - owned.record.inputCodeUnits
  ) {
    return
  }
  owned.record.preconnectInput.push({ data: input.data, kind: input.kind })
  owned.record.inputCodeUnits += input.data.length
}

export function releaseDeferredSplitPaneHandoff(handle: DeferredSplitPaneHandoffHandle): void {
  const owned = getOwnedRecord(handle)
  if (owned) {
    owned.record.owner = createHandle(owned.key)
  }
}

export function clearDeferredSplitPaneHandoff(handle: DeferredSplitPaneHandoffHandle): void {
  const owned = getOwnedRecord(handle)
  if (owned) {
    deleteHandoff(owned.key, owned.record)
  }
}

/** Drops a stale record when a restored pane already has an authoritative PTY. */
export function discardDeferredSplitPaneHandoffForKey(key: PaneKey): void {
  deleteHandoff(key)
}

export function discardDeferredSplitPaneHandoffsForTab(tabId: string): void {
  for (const [key, record] of handoffs) {
    if (parsePaneKey(key)?.tabId === tabId) {
      deleteHandoff(key, record)
    }
  }
}

export function resetDeferredSplitPaneHandoffsForTests(): void {
  for (const [key, record] of handoffs) {
    deleteHandoff(key, record)
  }
  keyByHandle = new WeakMap()
}

export function getDeferredSplitPaneHandoffCountForTests(): number {
  pruneExpiredHandoffs(Date.now())
  return handoffs.size
}
