// This member's synced arrangement of cloud workspaces (pins, their order, section order and
// collapsed sections), kept on the account (/v1/team/prefs) so every desktop and the phone agree.
// One copy per window. What shows is the server copy with this window's unsaved edits applied on
// top, so an edit shows at once. Edits save one at a time with compare-and-set: each applies to
// the newest server copy, and a stale write re-reads and applies the same edit again, so edits
// from two devices both land. Remote edits arrive by polling while the window is visible.
import { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  EMPTY_CLOUD_WORKSPACE_PREFS,
  type CloudWorkspacePrefsDocument
} from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'

/** Remote edits show up within this long while a window is visible. */
export const PREFS_POLL_MS = 15_000
const MAX_ATTEMPTS = 4

type Edit = (doc: CloudWorkspacePrefsDocument) => CloudWorkspacePrefsDocument

export type CloudWorkspacePrefsSnapshot = {
  /** `${userId}:${orgId}`; prefs belong to one account, so a team switch starts empty. */
  account: string | null
  /** The server copy with unsaved edits applied: what to render. */
  document: CloudWorkspacePrefsDocument
  loaded: boolean
}

let account: string | null = null
let server = { document: EMPTY_CLOUD_WORKSPACE_PREFS, revision: 0, loaded: false }
let pending: Edit[] = []
let queue: Promise<void> = Promise.resolve()
let snapshot: CloudWorkspacePrefsSnapshot = {
  account: null,
  document: EMPTY_CLOUD_WORKSPACE_PREFS,
  loaded: false
}
const listeners = new Set<() => void>()

function publish(): void {
  snapshot = {
    account,
    document: pending.reduce((doc, edit) => edit(doc), server.document),
    loaded: server.loaded
  }
  listeners.forEach((listener) => listener())
}

export function getCloudWorkspacePrefs(): CloudWorkspacePrefsSnapshot {
  return snapshot
}

export function useCloudWorkspacePrefs(): CloudWorkspacePrefsSnapshot {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => snapshot
  )
}

/** Switches to `next` (empty until read); a no-op when it is already the current account. */
export function setPrefsAccount(next: string | null): void {
  if (account === next) {
    return
  }
  account = next
  server = { document: EMPTY_CLOUD_WORKSPACE_PREFS, revision: 0, loaded: false }
  pending = []
  publish()
}

async function readServer(forAccount: string): Promise<boolean> {
  const result = await window.api.cloudWorkspaces.getPrefs()
  if (!result.ok || account !== forAccount) {
    return false
  }
  if (!server.loaded || result.value.revision !== server.revision) {
    server = { document: result.value.document, revision: result.value.revision, loaded: true }
    publish()
  }
  return true
}

/** Reads the server copy (polling, focus, Home opening). */
export async function refreshCloudWorkspacePrefs(): Promise<void> {
  if (account) {
    await readServer(account)
  }
}

async function save(forAccount: string, edit: Edit): Promise<boolean> {
  if (!server.loaded && !(await readServer(forAccount))) {
    return false
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const next = edit(server.document)
    if (next === server.document) {
      return true
    }
    const result = await window.api.cloudWorkspaces.putPrefs(next, server.revision)
    if (account !== forAccount) {
      return true
    }
    if (result.ok) {
      server = { document: result.value.document, revision: result.value.revision, loaded: true }
      return true
    }
    // Another device wrote first: take its copy and apply this edit to it.
    if (result.error !== 'conflict' || !(await readServer(forAccount))) {
      return false
    }
  }
  return false
}

/**
 * Shows `edit` now and saves it. If saving fails, the edit is dropped (the server copy shows
 * again) and a toast says so.
 */
export function editCloudWorkspacePrefs(edit: Edit): Promise<void> {
  const forAccount = account
  if (!forAccount || edit(snapshot.document) === snapshot.document) {
    return Promise.resolve()
  }
  pending = [...pending, edit]
  publish()
  queue = queue.then(async () => {
    const saved = await save(forAccount, edit).catch(() => false)
    if (account !== forAccount) {
      return
    }
    pending = pending.filter((other) => other !== edit)
    publish()
    if (!saved) {
      toast.error(
        translate(
          'auto.components.cloudWorkspaces.prefsSaveFailed',
          "Couldn't save that change, so your other devices won't show it. Try again."
        )
      )
    }
  })
  return queue
}

/** Test-only: forget everything. */
export function resetCloudWorkspacePrefsForTests(): void {
  account = null
  server = { document: EMPTY_CLOUD_WORKSPACE_PREFS, revision: 0, loaded: false }
  pending = []
  queue = Promise.resolve()
  snapshot = { account: null, document: EMPTY_CLOUD_WORKSPACE_PREFS, loaded: false }
  listeners.clear()
}
