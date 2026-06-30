export type ArchitectureAiRunKind = 'build' | 'fill' | 'review' | 'sync'
export type ArchitectureAiRunPhase =
  | 'idle'
  | 'launching'
  | 'running'
  | 'failed'
  | 'cancelled'
  | 'done'

export type ArchitectureAiRunState = {
  phase: ArchitectureAiRunPhase
  message: string | null
  runId: number
}

export type ArchitectureAiRunStore = Record<ArchitectureAiRunKind, ArchitectureAiRunState>

const TERMINAL_PHASES = new Set<ArchitectureAiRunPhase>(['failed', 'cancelled', 'done'])

function idleRun(): ArchitectureAiRunState {
  return { phase: 'idle', message: null, runId: 0 }
}

export function createInitialArchitectureAiRunState(): ArchitectureAiRunStore {
  return {
    build: idleRun(),
    fill: idleRun(),
    review: idleRun(),
    sync: idleRun()
  }
}

export function isArchitectureAiRunActive(state: ArchitectureAiRunState): boolean {
  return state.phase === 'launching' || state.phase === 'running'
}

export function beginArchitectureAiRun(
  state: ArchitectureAiRunStore,
  kind: ArchitectureAiRunKind,
  message: string | null = null
): { accepted: boolean; state: ArchitectureAiRunStore } {
  const current = state[kind]
  if (isArchitectureAiRunActive(current)) {
    return { accepted: false, state }
  }
  return {
    accepted: true,
    state: {
      ...state,
      [kind]: {
        phase: 'launching',
        message,
        runId: current.runId + 1
      }
    }
  }
}

export function transitionArchitectureAiRun(
  state: ArchitectureAiRunStore,
  kind: ArchitectureAiRunKind,
  phase: ArchitectureAiRunPhase,
  message: string | null = null
): { changed: boolean; state: ArchitectureAiRunStore } {
  const current = state[kind]
  if (TERMINAL_PHASES.has(current.phase)) {
    return { changed: false, state }
  }
  if (current.phase === 'idle' && phase !== 'launching') {
    return { changed: false, state }
  }
  return {
    changed: true,
    state: {
      ...state,
      [kind]: {
        ...current,
        phase,
        message
      }
    }
  }
}

export function forceArchitectureAiRunState(
  state: ArchitectureAiRunStore,
  kind: ArchitectureAiRunKind,
  phase: ArchitectureAiRunPhase,
  message: string | null = null
): ArchitectureAiRunStore {
  return {
    ...state,
    [kind]: {
      ...state[kind],
      phase,
      message
    }
  }
}
