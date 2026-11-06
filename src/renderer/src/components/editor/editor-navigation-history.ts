import { LINE_JUMP_THRESHOLD, MAX_HISTORY_ENTRIES, DIRECTION } from './editor-navigation.consts'
import type {
  Location,
  HistoryState,
  Direction,
  CanVisitLocation,
  History,
  HistoryStateRef
} from './editor-navigation.types'

const sameEditor = (a: Location, b: Location): boolean => {
  return (
    a.file.id === b.file.id &&
    a.file.worktreeId === b.file.worktreeId &&
    a.ownerKey === b.ownerKey &&
    a.tabId === b.tabId &&
    a.viewStateId === b.viewStateId
  )
}

const coalescesLocation = (
  current: Location,
  location: Location,
  explicitJump: boolean
): boolean => {
  return (
    sameEditor(current, location) &&
    ((current.position.lineNumber === location.position.lineNumber &&
      current.position.column === location.position.column) ||
      (!explicitJump &&
        Math.abs(current.position.lineNumber - location.position.lineNumber) < LINE_JUMP_THRESHOLD))
  )
}

const replaceCurrent = (state: HistoryState, location: Location): HistoryState => {
  return {
    ...state,
    entries: state.entries.map((entry, index) => (index === state.index ? location : entry))
  }
}

const recordLocation = (
  state: HistoryState,
  location: Location,
  explicitJump: boolean
): HistoryState => {
  const current = state.entries[state.index]

  if (current && coalescesLocation(current, location, explicitJump)) {
    return replaceCurrent(state, location)
  }

  const entries = [...state.entries.slice(0, state.index + 1), location].slice(-MAX_HISTORY_ENTRIES)

  return { entries, index: entries.length - 1 }
}

const updateLocation = (state: HistoryState, location: Location): HistoryState => {
  const current = state.entries[state.index]

  return current && sameEditor(current, location) ? replaceCurrent(state, location) : state
}

const nextLocationIndex = (
  state: HistoryState,
  direction: Direction,
  canVisit: CanVisitLocation
): number => {
  return direction === DIRECTION.BACK
    ? state.entries.findLastIndex((location, index) => index < state.index && canVisit(location))
    : state.entries.findIndex((location, index) => index > state.index && canVisit(location))
}

export const createEditorNavigationHistory = (): History => {
  const state: HistoryStateRef = { current: { entries: [], index: -1 } }

  return {
    record: (location: Location, explicitJump = false): void => {
      state.current = recordLocation(state.current, location, explicitJump)
    },
    update: (location: Location): void => {
      state.current = updateLocation(state.current, location)
    },
    replaceCurrent: (location: Location): void => {
      state.current = replaceCurrent(state.current, location)
    },
    step: (direction: Direction, canVisit: CanVisitLocation = () => true): Location | null => {
      const index = nextLocationIndex(state.current, direction, canVisit)

      if (index < 0) {
        return null
      }

      state.current = { ...state.current, index }

      return state.current.entries[index]
    }
  }
}
