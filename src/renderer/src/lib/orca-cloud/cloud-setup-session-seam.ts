// Seam for the one-trip setup session (spec N1, owned by team-billing-ux / np4-setup). Until the
// session exists, the composer derives setup rows from billing access and availability and "Set up
// and start" runs today's sign-in / plans actions. When the session lands, np4-setup registers:
// - a starter: "Set up and start" calls it and keeps the returned session id (also on the draft);
// - a source: a synchronous read of the latest polled snapshot for a session id;
// and calls notifyCloudSetupSessionChanged() after each poll so the panel re-renders.
import { useCallback, useSyncExternalStore } from 'react'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'

/** "All set" holds this long before the composer submits itself (O4; 0 with reduced motion). */
export const CLOUD_SETUP_ALL_SET_HOLD_MS = 600

export type CloudSetupSessionSnapshot = {
  steps: CloudSetupStep[]
  finished: boolean
  /** A step the browser couldn't finish (kinds agreed with the setup-session API). */
  error?: { kind: string; detail?: string }
  /** The team setup is for, once known (names it in the wrong-account error). */
  teamName?: string
}

/**
 * A fresh one-time link back into an open setup session (the first one was spent by the browser
 * that opened it). Null when the session is gone. Used by "Copy setup link" and "Reopen browser".
 */
type SessionLinkProvider = (sessionId: string) => Promise<string | null>
let linkProvider: SessionLinkProvider | null = null

/** np4-setup registers the session link minting here. Pass null to remove it. */
export function setCloudSetupLinkProvider(next: SessionLinkProvider | null): void {
  linkProvider = next
}

export function getCloudSetupLinkProvider(): SessionLinkProvider | null {
  return linkProvider
}

type SessionSource = (sessionId: string) => CloudSetupSessionSnapshot | null

export type CloudSetupStartRequest = {
  repoId: string
  /** The rows still open when the user clicked (account, team, plan, github). */
  needs: CloudSetupStep['id'][]
}
/** Null when the session couldn't open; the composer then falls back to today's actions. */
type SessionStarter = (request: CloudSetupStartRequest) => Promise<{ sessionId: string } | null>

let source: SessionSource | null = null
let starter: SessionStarter | null = null
const listeners = new Set<() => void>()

/** Register the session poller's read. Pass null to remove it. */
export function setCloudSetupSessionSource(next: SessionSource | null): void {
  source = next
  notifyCloudSetupSessionChanged()
}

/** Register what "Set up and start" calls to open the one browser trip. Pass null to remove it. */
export function setCloudSetupStarter(next: SessionStarter | null): void {
  starter = next
}

export function getCloudSetupStarter(): SessionStarter | null {
  return starter
}

export function readCloudSetupSession(sessionId: string | null): CloudSetupSessionSnapshot | null {
  return sessionId && source ? source(sessionId) : null
}

// Bumped on every change, so a read is cached per (session, revision): useSyncExternalStore needs
// the same object back until something changed.
let revision = 0
const cachedReads = new Map<string, { revision: number; value: CloudSetupSessionSnapshot | null }>()

/** Call after each poll so open composers re-read their session. */
export function notifyCloudSetupSessionChanged(): void {
  revision += 1
  for (const listener of listeners) {
    listener()
  }
}

export function subscribeCloudSetupSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The latest snapshot for a session: the same object until the next poll or source change. */
export function getCloudSetupSessionSnapshot(
  sessionId: string | null
): CloudSetupSessionSnapshot | null {
  if (!sessionId) {
    return null
  }
  const cached = cachedReads.get(sessionId)
  if (cached?.revision === revision) {
    return cached.value
  }
  const value = readCloudSetupSession(sessionId)
  cachedReads.set(sessionId, { revision, value })
  return value
}

/**
 * A setup session's snapshot that re-renders on every poll. Read it through this hook, never by
 * calling readCloudSetupSession in a render: the React Compiler memoizes a bare call on its
 * arguments, so the panel would keep the first (empty) read and never see the session move on.
 */
export function useCloudSetupSession(sessionId: string | null): CloudSetupSessionSnapshot | null {
  const getSnapshot = useCallback(() => getCloudSetupSessionSnapshot(sessionId), [sessionId])
  return useSyncExternalStore(subscribeCloudSetupSession, getSnapshot)
}
