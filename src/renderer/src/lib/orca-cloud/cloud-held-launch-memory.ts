// A held Orca Cloud launch waits in a plain-shell placeholder tab on the host, and the hold
// itself lives only in memory (cloud-agent-launch-hold). A quit loses it: the placeholder comes back
// as a plain shell with no strip and no way to start the agent. This keeps one record per held
// placeholder so a restart can put the hold back. Per Orca profile, on this device; never the
// launch's env, command or secrets, only what re-planning the launch needs.
import { useAppStore } from '@/store'
import type { CreateWebRuntimeSessionTerminalOnHostArgs } from '@/runtime/hosted-terminals/creation/terminal-create-contracts'

/**
 * The composer's non-secret launch choices (model, effort, permission mode, chat or terminal), so a
 * launch restored after a restart starts the way it was asked for. Plain JSON; never env or command.
 */
export type HeldCloudLaunchOptions = Pick<
  CreateWebRuntimeSessionTerminalOnHostArgs,
  | 'launchAgent'
  | 'agentArgs'
  | 'launchPreferences'
  | 'sessionOptions'
  | 'extraAgentArgs'
  | 'promptDelivery'
  | 'viewMode'
>

/** The launch options worth keeping across a restart, from a create's args. */
export function heldLaunchOptions({
  launchAgent,
  agentArgs,
  launchPreferences,
  sessionOptions,
  extraAgentArgs,
  promptDelivery,
  viewMode
}: CreateWebRuntimeSessionTerminalOnHostArgs): HeldCloudLaunchOptions {
  return {
    ...(launchAgent !== undefined ? { launchAgent } : {}),
    ...(agentArgs !== undefined ? { agentArgs } : {}),
    ...(launchPreferences !== undefined ? { launchPreferences } : {}),
    ...(sessionOptions !== undefined ? { sessionOptions } : {}),
    ...(extraAgentArgs !== undefined ? { extraAgentArgs } : {}),
    ...(promptDelivery !== undefined ? { promptDelivery } : {}),
    ...(viewMode !== undefined ? { viewMode } : {})
  }
}

export type HeldCloudLaunchRecord = {
  environmentId: string
  worktreeId: string
  /** The placeholder's surface tab id (derived from the host tab id, which the host keeps). */
  tabId: string
  agent: 'claude' | 'codex'
  prompt: string | null
  cwd: string | null
  targetGroupId: string | null
  /** Absent on records written before the options were kept: those start with host defaults. */
  options?: HeldCloudLaunchOptions
  createdAt: number
}

const KEY_PREFIX = 'orca.cloudHeldLaunches.v1'
/** Bounded so a long-lived profile can't grow the record without limit. */
const MAX_RECORDS = 50
/**
 * A record left by a workspace or sandbox deleted while the app was closed never meets its tab
 * again; it ages out (a restored one is also dropped once its tab doesn't come back).
 */
const HELD_LAUNCH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function storage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

function storageKey(profileId: string | null): string {
  return `${KEY_PREFIX}:${profileId ?? 'default'}`
}

function activeProfileId(): string | null {
  return useAppStore.getState().activeOrcaProfileId ?? null
}

function isRecord(value: unknown): value is HeldCloudLaunchRecord {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const record: Partial<Record<keyof HeldCloudLaunchRecord, unknown>> = value
  return (
    typeof record.environmentId === 'string' &&
    typeof record.worktreeId === 'string' &&
    typeof record.tabId === 'string' &&
    (record.agent === 'claude' || record.agent === 'codex') &&
    (record.prompt === null || typeof record.prompt === 'string') &&
    (record.cwd === null || typeof record.cwd === 'string') &&
    (record.targetGroupId === null || typeof record.targetGroupId === 'string') &&
    (record.options === undefined ||
      (typeof record.options === 'object' && record.options !== null && !Array.isArray(record.options))) &&
    typeof record.createdAt === 'number'
  )
}

function readAll(profileId: string | null): HeldCloudLaunchRecord[] {
  try {
    const raw = storage()?.getItem(storageKey(profileId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const now = Date.now()
    return Array.isArray(parsed)
      ? parsed.filter(isRecord).filter((each) => now - each.createdAt < HELD_LAUNCH_MAX_AGE_MS)
      : []
  } catch {
    return []
  }
}

function writeAll(profileId: string | null, records: HeldCloudLaunchRecord[]): void {
  try {
    const kept = records.slice(-MAX_RECORDS)
    if (kept.length === 0) {
      storage()?.removeItem(storageKey(profileId))
    } else {
      storage()?.setItem(storageKey(profileId), JSON.stringify(kept))
    }
  } catch {
    // Storage full or unavailable: the hold still works for this run, it just won't survive a quit.
  }
}

/** Remember a held placeholder (replacing any record for the same tab). */
export function rememberHeldCloudLaunch(record: HeldCloudLaunchRecord): void {
  const profileId = activeProfileId()
  writeAll(profileId, [...readAll(profileId).filter((each) => each.tabId !== record.tabId), record])
}

/** Forget a placeholder's record: its hold settled (Start, cancel) or its tab is gone. */
export function forgetHeldCloudLaunch(tabId: string): void {
  const profileId = activeProfileId()
  const records = readAll(profileId)
  const kept = records.filter((each) => each.tabId !== tabId)
  if (kept.length !== records.length) {
    writeAll(profileId, kept)
  }
}

/** The records for one Orca Cloud environment, for the active profile. */
export function readHeldCloudLaunches(environmentId: string): HeldCloudLaunchRecord[] {
  return readAll(activeProfileId()).filter((each) => each.environmentId === environmentId)
}
