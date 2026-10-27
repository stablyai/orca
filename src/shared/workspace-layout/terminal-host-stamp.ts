// A tab-bar entry's cross-host stamp: the host a terminal runs on and the project setup it starts in.
// The setup key alone marks it, so a corrupt stamp stays remote intent and is never re-minted local.

import { z } from 'zod'
import { parseExecutionHostId, type ExecutionHostId } from '../execution-host'
import type { StoredJsonValue } from '../tab-types'

/** The stamp exactly as the entry holds it; `setup` is whatever value was stored under the key. */
export type TerminalHostStamp = { setup: StoredJsonValue; executionHostId?: ExecutionHostId }

export type ParsedTerminalHostStamp =
  | { kind: 'invalid'; reason: 'missing_setup' | 'host_not_runtime' }
  | {
      kind: 'stamped'
      environmentId: string
      executionHostId: ExecutionHostId
      projectHostSetupId: string
    }

/** Whether a stored value names a host this build can read; the session schema's own test. */
export function isReadableExecutionHostId(value: unknown): value is ExecutionHostId {
  return typeof value === 'string' && Boolean(parseExecutionHostId(value))
}

/** A stored execution host id, validated by the one shared test. */
export const executionHostIdSchema = z.custom<ExecutionHostId>(isReadableExecutionHostId)

function withoutUnreadableStampHost(raw: unknown): unknown {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('projectHostSetupId' in raw) ||
    !('executionHostId' in raw) ||
    isReadableExecutionHostId(raw.executionHostId)
  ) {
    return raw
  }
  return Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'executionHostId'))
}

// Why: a stamped entry whose host cannot be read stays a refused stamp; failing the entry would
// re-mint its terminal row as an ordinary local tab. Only the unreadable host value is lost.
export function keepingStampedEntries<Entry extends z.ZodType>(entry: Entry) {
  return z.preprocess(withoutUnreadableStampHost, entry)
}

/** Null for an ordinary entry: one with no setup key, whatever host it names. */
export function readTerminalHostStamp(entry: {
  executionHostId?: ExecutionHostId
  projectHostSetupId?: StoredJsonValue
}): TerminalHostStamp | null {
  if (entry.projectHostSetupId === undefined) {
    return null
  }
  return {
    setup: entry.projectHostSetupId,
    ...(entry.executionHostId !== undefined ? { executionHostId: entry.executionHostId } : {})
  }
}

/** A present stamp runs only on a runtime host with a setup; anything else is refused, never local. */
export function parseTerminalHostStamp(setup: unknown, host: unknown): ParsedTerminalHostStamp {
  if (typeof setup !== 'string' || !setup.trim()) {
    return { kind: 'invalid', reason: 'missing_setup' }
  }
  const parsed = typeof host === 'string' ? parseExecutionHostId(host) : null
  if (parsed?.kind !== 'runtime' || !parsed.environmentId.trim()) {
    return { kind: 'invalid', reason: 'host_not_runtime' }
  }
  return {
    kind: 'stamped',
    environmentId: parsed.environmentId,
    executionHostId: parsed.id,
    projectHostSetupId: setup
  }
}
