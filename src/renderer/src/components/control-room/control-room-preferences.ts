export type ControlRoomScope = 'active' | 'all' | 'pinned'

export type ControlRoomPreferences = {
  version: 1
  scope: ControlRoomScope
  pinnedSessionKeys: string[]
}

const STORAGE_KEY = 'orca:control-room:v1'
const MAX_PINNED_SESSIONS = 500

export const DEFAULT_CONTROL_ROOM_PREFERENCES: ControlRoomPreferences = {
  version: 1,
  scope: 'active',
  pinnedSessionKeys: []
}

function normalizeScope(value: unknown): ControlRoomScope {
  return value === 'all' || value === 'pinned' ? value : 'active'
}

export function normalizeControlRoomPreferences(value: unknown): ControlRoomPreferences {
  const candidate = value && typeof value === 'object' ? value : {}
  const rawPins =
    'pinnedSessionKeys' in candidate && Array.isArray(candidate.pinnedSessionKeys)
      ? candidate.pinnedSessionKeys
      : []
  return {
    version: 1,
    scope: normalizeScope('scope' in candidate ? candidate.scope : undefined),
    pinnedSessionKeys: Array.from(
      new Set(
        rawPins.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      )
    ).slice(0, MAX_PINNED_SESSIONS)
  }
}

export function readControlRoomPreferences(
  storage: Pick<Storage, 'getItem'>
): ControlRoomPreferences {
  try {
    const raw = storage.getItem(STORAGE_KEY)
    return raw ? normalizeControlRoomPreferences(JSON.parse(raw)) : DEFAULT_CONTROL_ROOM_PREFERENCES
  } catch {
    return DEFAULT_CONTROL_ROOM_PREFERENCES
  }
}

export function writeControlRoomPreferences(
  storage: Pick<Storage, 'setItem'>,
  preferences: ControlRoomPreferences
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(normalizeControlRoomPreferences(preferences)))
  } catch {
    // Why: a blocked localStorage must not make the live Control Room unusable.
  }
}
