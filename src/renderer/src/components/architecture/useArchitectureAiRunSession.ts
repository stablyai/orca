import { useCallback, useState } from 'react'
import {
  beginArchitectureAiRun,
  createInitialArchitectureAiRunState,
  forceArchitectureAiRunState,
  transitionArchitectureAiRun,
  type ArchitectureAiRunKind,
  type ArchitectureAiRunPhase
} from './architecture-ai-run-state'

export type {
  ArchitectureAiRunKind,
  ArchitectureAiRunPhase,
  ArchitectureAiRunState
} from './architecture-ai-run-state'

export function useArchitectureAiRunSession() {
  const [runStates, setRunStates] = useState(createInitialArchitectureAiRunState)

  const beginRun = useCallback(
    (kind: ArchitectureAiRunKind, message: string | null = null): boolean => {
      let accepted = false
      setRunStates((current) => {
        const next = beginArchitectureAiRun(current, kind, message)
        accepted = next.accepted
        return next.state
      })
      return accepted
    },
    []
  )

  const markRun = useCallback(
    (kind: ArchitectureAiRunKind, phase: ArchitectureAiRunPhase, message: string | null = null) => {
      setRunStates((current) => transitionArchitectureAiRun(current, kind, phase, message).state)
    },
    []
  )

  const forceReleaseRun = useCallback(
    (kind: ArchitectureAiRunKind, phase: ArchitectureAiRunPhase, message: string | null = null) => {
      setRunStates((current) => forceArchitectureAiRunState(current, kind, phase, message))
    },
    []
  )

  return {
    runStates,
    beginRun,
    markRun,
    forceReleaseRun
  }
}
