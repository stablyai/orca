import { useMemo, useSyncExternalStore } from 'react'

import type { Worktree } from '../../../../shared/worktree/types'
import {
  getWorkspaceColorTagFallbackIdentity,
  getWorkspaceColorTagIdentity
} from '../../../../shared/workspace-color-tag'

/**
 * Transient per-card color preview: what the custom picker shows while dragging, and what a write
 * shows while it is in flight.
 *
 * Why not the store: the store's only optimistic apply also persists, so previewing through it
 * would issue a metadata write per pointer move, and a folder workspace on a paired runtime has no
 * optimistic apply at all and can wait the full RPC timeout. This holds the color the user is
 * *looking at*; the popover commits once on close, and the write coordinator clears its entry once
 * its queue drains. Keyed by color-tag identity so the same worktree id on two hosts previews
 * independently. Nothing here is persisted or synced.
 *
 * Why owners, layered: a picker that has closed keeps holding its preview until its write lands, and
 * a pending write holds one too. If another picker previews the same card in the meantime, neither
 * earlier holder's clear may erase the newer live preview, and when the newer one is cleared (Escape
 * on the picker) the card must show the color still held beneath it, not the persisted strip. So
 * every row keeps one layer per owner, bottom to top, and the top layer is what the card shows.
 */
export type WorkspaceColorTagPreviewOwner = symbol

export function createWorkspaceColorTagPreviewOwner(): WorkspaceColorTagPreviewOwner {
  return Symbol('workspace-color-tag-preview')
}

export type PreviewedWorktree = Pick<
  Worktree,
  'id' | 'hostId' | 'identity' | 'runtimeOwnerEnvironmentId'
>

/** A previewed `null` is "no color", as distinct from `undefined`, "nothing previewed". */
type PreviewLayer = {
  colorTag: string | null
  owner: WorkspaceColorTagPreviewOwner
  /** The canonical identity this layer was set on behalf of, when a fallback-key layer knows it. */
  forIdentity?: string
  /** Set order across every key; the reader picks the newest applicable layer across a row's keys. */
  sequence: number
}
let nextLayerSequence = 0

export type WorkspaceColorTagPreviewScope = {
  /** Why: a checkout replaced at the same path must not read its predecessor's fallback layer. */
  forIdentity?: string
}

/** Bottom to top per identity; the top layer is what the card shows. */
const previews = new Map<string, PreviewLayer[]>()
const listeners = new Set<() => void>()

function topLayer(identity: string): string | null | undefined {
  const layers = previews.get(identity)
  return layers ? layers.at(-1)?.colorTag : undefined
}

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Why batch: a drag fires per pointer move across every selected card, and every mounted card
// subscribes. Mutating the whole set and notifying once keeps that at one broadcast per move
// instead of selected × rendered.
type PreviewEntry = { identity: string; colorTag: string | null; forIdentity?: string }

function applyPreviewEntries(
  entries: readonly PreviewEntry[],
  owner: WorkspaceColorTagPreviewOwner
): void {
  let changed = false
  for (const { identity, colorTag, forIdentity } of entries) {
    const layers = previews.get(identity) ?? []
    const index = layers.findIndex((layer) => layer.owner === owner)
    const top = layers.at(-1)
    if (
      index === layers.length - 1 &&
      top?.colorTag === colorTag &&
      top.forIdentity === forIdentity
    ) {
      continue
    }
    if (index !== -1) {
      layers.splice(index, 1)
    }
    layers.push({ colorTag, owner, forIdentity, sequence: ++nextLayerSequence })
    previews.set(identity, layers)
    changed = true
  }
  if (changed) {
    emit()
  }
}

export function setWorkspaceColorTagPreviews(
  identities: readonly string[],
  colorTag: string | null,
  owner: WorkspaceColorTagPreviewOwner,
  scope?: WorkspaceColorTagPreviewScope
): void {
  applyPreviewEntries(
    identities.map((identity) => ({ identity, colorTag, forIdentity: scope?.forIdentity })),
    owner
  )
}

/**
 * Every key a row's preview must reach: its canonical key, and its pre-identity key scoped to the
 * occupant, so a copy of the row that has not refreshed yet follows along while a checkout that
 * replaced it at the same path does not. An identity-less row has one key; it is scoped to the
 * occupant its caller knows, if any.
 */
function previewEntriesFor(
  rows: readonly PreviewedWorktree[],
  colorTag: string | null,
  occupant: string | undefined
): PreviewEntry[] {
  const entries: PreviewEntry[] = []
  for (const row of rows) {
    const canonical = getWorkspaceColorTagIdentity(row)
    const fallback = getWorkspaceColorTagFallbackIdentity(row)
    const forIdentity = row.identity?.key ?? occupant
    if (canonical === fallback) {
      entries.push({ identity: canonical, colorTag, forIdentity })
      continue
    }
    entries.push({ identity: canonical, colorTag }, { identity: fallback, colorTag, forIdentity })
  }
  return entries
}

/** Both keys of every row, deduplicated; what a clear must cover after previewing these rows. */
export function workspaceColorTagPreviewKeysFor(rows: readonly PreviewedWorktree[]): string[] {
  return [
    ...new Set(
      rows.flatMap((row) => [
        getWorkspaceColorTagIdentity(row),
        getWorkspaceColorTagFallbackIdentity(row)
      ])
    )
  ]
}

/** Previews `colorTag` on every representation of these rows in one broadcast. */
export function previewWorkspaceColorTagsFor(
  rows: readonly PreviewedWorktree[],
  colorTag: string | null,
  owner: WorkspaceColorTagPreviewOwner,
  occupant?: string
): void {
  applyPreviewEntries(previewEntriesFor(rows, colorTag, occupant), owner)
}

export function clearWorkspaceColorTagPreviewsFor(
  rows: readonly PreviewedWorktree[],
  owner: WorkspaceColorTagPreviewOwner
): void {
  clearWorkspaceColorTagPreviews(workspaceColorTagPreviewKeysFor(rows), owner)
}

/** Removes only this owner's layer; whatever another holder set above or beneath it stays. */
export function clearWorkspaceColorTagPreviews(
  identities: readonly string[],
  owner: WorkspaceColorTagPreviewOwner
): void {
  let changed = false
  for (const identity of identities) {
    const layers = previews.get(identity)
    const index = layers?.findIndex((layer) => layer.owner === owner) ?? -1
    if (!layers || index === -1) {
      continue
    }
    layers.splice(index, 1)
    if (layers.length === 0) {
      previews.delete(identity)
    }
    changed = true
  }
  if (changed) {
    emit()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * The previewed color for this row, or undefined when nothing is being previewed. Why two keys: a
 * background refresh can give an identity-less row its canonical identity while a picker session
 * or a queued write still previews under the old key; the card must keep seeing that preview.
 */
export function readWorkspaceColorTagPreview(
  worktree: PreviewedWorktree
): string | null | undefined {
  const canonical = previews.get(getWorkspaceColorTagIdentity(worktree))?.at(-1)
  // Why filter: a fallback layer set on behalf of another identity belongs to a previous occupant
  // of this path; a row with its own identity must not show it. A row without one cannot tell.
  const own = worktree.identity?.key
  const layers = previews.get(getWorkspaceColorTagFallbackIdentity(worktree)) ?? []
  let fallback: PreviewLayer | undefined
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index]
    if (
      layer &&
      (own === undefined || layer.forIdentity === undefined || layer.forIdentity === own)
    ) {
      fallback = layer
      break
    }
  }
  // Why the newest across both keys: a pending write can sit under the canonical key while a newer
  // picker preview from an identity-less copy of the row sits under the pre-identity key; both
  // representations must show the newer one, not each its own.
  if (canonical && fallback) {
    return canonical.sequence >= fallback.sequence ? canonical.colorTag : fallback.colorTag
  }
  return (canonical ?? fallback)?.colorTag
}

/** The previewed color for this card, or undefined when nothing is being previewed. */
export function useWorkspaceColorTagPreview(identity: string): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => topLayer(identity),
    () => undefined
  )
}

export function useWorkspaceColorTagPreviewForWorktree(
  worktree: PreviewedWorktree
): string | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => readWorkspaceColorTagPreview(worktree),
    () => undefined
  )
}

// Why serialize: useSyncExternalStore compares snapshots by identity, so a fresh array every read
// would re-render on every broadcast; a string only changes when a previewed value does. Zero stands
// for "nothing previewed", which JSON would otherwise fold into null.
function serializePreviews(worktrees: readonly PreviewedWorktree[]): string {
  return JSON.stringify(
    worktrees.map((worktree) => {
      const preview = readWorkspaceColorTagPreview(worktree)
      return preview === undefined ? 0 : preview
    })
  )
}

/** Previewed colors for several rows at once, in order; undefined where nothing is previewed. */
export function useWorkspaceColorTagPreviewsForWorktrees(
  worktrees: readonly PreviewedWorktree[]
): readonly (string | null | undefined)[] {
  const serialized = useSyncExternalStore(
    subscribe,
    () => serializePreviews(worktrees),
    () => serializePreviews([])
  )
  return useMemo(
    () =>
      (JSON.parse(serialized) as (string | null | 0)[]).map((value) =>
        value === 0 ? undefined : value
      ),
    [serialized]
  )
}
