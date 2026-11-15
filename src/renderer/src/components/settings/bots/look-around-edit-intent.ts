import type { LookAroundPatch } from '../../../../../shared/bots/bot-look-around'

const FIELDS = ['timezone', 'on', 'weekdaysOnly', 'focus'] as const
export type LookEditIntent = { schedule: number } & Record<(typeof FIELDS)[number], number>
export type LookEditState = { key: string; latest: LookEditIntent; pending: number }

// A reopened editor must supersede preflights from its previous instance.
const pendingEdits = new Map<string, LookEditState>()
let nextEditToken = 0

export function createLookEditState(key: string): LookEditState {
  return { key, latest: { schedule: 0, timezone: 0, on: 0, weekdaysOnly: 0, focus: 0 }, pending: 0 }
}

export function lookEditState(key: string, local: LookEditState): LookEditState {
  const current = pendingEdits.get(key)
  if (!current) {
    return local.key === key ? local : createLookEditState(key)
  }
  if (local.key === key) {
    current.latest.schedule = Math.max(current.latest.schedule, local.latest.schedule)
    for (const field of FIELDS) {
      current.latest[field] = Math.max(current.latest[field], local.latest[field])
    }
  }
  return current
}

export function stageLookEdit(state: LookEditState, patch: LookAroundPatch): LookEditIntent {
  const token = ++nextEditToken
  if (patch.every !== undefined || patch.times !== undefined) {
    state.latest.schedule = token
  }
  for (const field of FIELDS) {
    if (patch[field] !== undefined) {
      state.latest[field] = token
    }
  }
  return { ...state.latest }
}

export function currentLookEdit(
  state: LookEditState,
  intent: LookEditIntent,
  patch: LookAroundPatch
): LookAroundPatch {
  const { latest } = lookEditState(state.key, state)
  const kept = { ...patch }
  if (intent.schedule !== latest.schedule) {
    delete kept.every
    delete kept.times
  }
  for (const field of FIELDS) {
    if (intent[field] !== latest[field]) {
      delete kept[field]
    }
  }
  return kept
}

export async function withLookEditPreflight(
  state: LookEditState,
  check: () => Promise<boolean>,
  commit: (current: LookEditState) => void
): Promise<void> {
  const current = lookEditState(state.key, state)
  current.pending += 1
  pendingEdits.set(current.key, current)
  try {
    if (await check()) {
      commit(current)
    }
  } finally {
    current.pending -= 1
    if (current.pending === 0 && pendingEdits.get(current.key) === current) {
      pendingEdits.delete(current.key)
    }
  }
}
