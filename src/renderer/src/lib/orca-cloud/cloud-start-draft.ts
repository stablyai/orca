// The composer draft that "Start in Orca Cloud" keeps across the setup trip: prompt,
// project, agent and the setup session, saved to disk so quitting Orca mid-setup loses nothing.
// One draft per Orca profile, so a profile or team switch can't resume someone else's draft.
// team-billing-ux sets `setupSessionId` when it opens a setup session.

export type CloudStartDraft = {
  prompt: string
  repoId: string
  agent: string | null
  target: 'orca-cloud'
  setupSessionId: string | null
  createdAt: number
}

const KEY_PREFIX = 'orca.cloudStart.draft.v1'
/** Auto-start only resumes a draft this recent. */
export const CLOUD_START_DRAFT_MAX_AGE_MS = 30 * 60_000

function storageKey(profileId: string | null): string {
  return `${KEY_PREFIX}:${profileId ?? 'default'}`
}

function defaultStorage(): Storage | undefined {
  return typeof localStorage === 'undefined' ? undefined : localStorage
}

export function saveCloudStartDraft(
  profileId: string | null,
  draft: CloudStartDraft,
  storage: Storage | undefined = defaultStorage()
): void {
  try {
    storage?.setItem(storageKey(profileId), JSON.stringify(draft))
  } catch {
    // Quota or private mode: setup still works, the draft just won't survive a quit.
  }
}

export function readCloudStartDraft(
  profileId: string | null,
  now: number = Date.now(),
  storage: Storage | undefined = defaultStorage()
): CloudStartDraft | null {
  try {
    const raw = storage?.getItem(storageKey(profileId))
    if (!raw) {
      return null
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return null
    }
    const draft: Partial<Record<keyof CloudStartDraft, unknown>> = parsed
    if (
      typeof draft.prompt !== 'string' ||
      typeof draft.repoId !== 'string' ||
      draft.target !== 'orca-cloud' ||
      typeof draft.createdAt !== 'number'
    ) {
      return null
    }
    if (now - draft.createdAt > CLOUD_START_DRAFT_MAX_AGE_MS) {
      clearCloudStartDraft(profileId, storage)
      return null
    }
    return {
      prompt: draft.prompt,
      repoId: draft.repoId,
      agent: typeof draft.agent === 'string' ? draft.agent : null,
      target: 'orca-cloud',
      setupSessionId: typeof draft.setupSessionId === 'string' ? draft.setupSessionId : null,
      createdAt: draft.createdAt
    }
  } catch {
    return null
  }
}

/** On a successful create, or when the user discards the setup. */
export function clearCloudStartDraft(
  profileId: string | null,
  storage: Storage | undefined = defaultStorage()
): void {
  try {
    storage?.removeItem(storageKey(profileId))
  } catch {
    // Nothing to clean up.
  }
}
