import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export const COLD_PARKED_PRESENTATION_FALLBACK_MS = 1_000

type PresentationEntry = {
  presentedTargetId: string | null
  pendingTargetId: string | null
}

export type ColdParkedPresentationState = ReadonlyMap<string, PresentationEntry>

type PresentationInputs = {
  desiredTargetByScope: ReadonlyMap<string, string | null>
  coldParkedTargetIds: ReadonlySet<string>
  availableTargetIds: ReadonlySet<string>
}

function haveSameEntries(
  left: ColdParkedPresentationState,
  right: ColdParkedPresentationState
): boolean {
  if (left.size !== right.size) {
    return false
  }
  for (const [scopeId, entry] of left) {
    const other = right.get(scopeId)
    if (
      !other ||
      entry.presentedTargetId !== other.presentedTargetId ||
      entry.pendingTargetId !== other.pendingTargetId
    ) {
      return false
    }
  }
  return true
}

export function createColdParkedPresentationState(
  desiredTargetByScope: ReadonlyMap<string, string | null>
): ColdParkedPresentationState {
  return new Map(
    Array.from(desiredTargetByScope, ([scopeId, targetId]) => [
      scopeId,
      { presentedTargetId: targetId, pendingTargetId: null }
    ])
  )
}

export function resolveColdParkedPresentation(
  current: ColdParkedPresentationState,
  inputs: PresentationInputs
): ColdParkedPresentationState {
  const next = new Map<string, PresentationEntry>()
  for (const [scopeId, desiredTargetId] of inputs.desiredTargetByScope) {
    const entry = current.get(scopeId) ?? {
      presentedTargetId: null,
      pendingTargetId: null
    }
    if (entry.pendingTargetId !== null && entry.pendingTargetId === desiredTargetId) {
      next.set(scopeId, entry)
      continue
    }
    const canRetainPresentedTarget =
      entry.presentedTargetId !== null && inputs.availableTargetIds.has(entry.presentedTargetId)
    const shouldWait =
      desiredTargetId !== null &&
      desiredTargetId !== entry.presentedTargetId &&
      canRetainPresentedTarget &&
      inputs.coldParkedTargetIds.has(desiredTargetId)
    next.set(
      scopeId,
      shouldWait
        ? { presentedTargetId: entry.presentedTargetId, pendingTargetId: desiredTargetId }
        : { presentedTargetId: desiredTargetId, pendingTargetId: null }
    )
  }
  return haveSameEntries(current, next) ? current : next
}

function settlePresentationTarget(
  current: ColdParkedPresentationState,
  desiredTargetByScope: ReadonlyMap<string, string | null>,
  targetId: string
): ColdParkedPresentationState {
  let changed = false
  const next = new Map(current)
  for (const [scopeId, entry] of current) {
    if (entry.pendingTargetId !== targetId || desiredTargetByScope.get(scopeId) !== targetId) {
      continue
    }
    next.set(scopeId, { presentedTargetId: targetId, pendingTargetId: null })
    changed = true
  }
  return changed ? next : current
}

export function useColdParkedTerminalPresentation(
  inputs: PresentationInputs,
  fallbackMs = COLD_PARKED_PRESENTATION_FALLBACK_MS
): {
  presentationByScope: ColdParkedPresentationState
  settleTarget: (targetId: string) => void
} {
  const [committed, setCommitted] = useState<ColdParkedPresentationState>(() =>
    createColdParkedPresentationState(inputs.desiredTargetByScope)
  )
  const latestInputsRef = useRef(inputs)
  latestInputsRef.current = inputs
  const presentationByScope = resolveColdParkedPresentation(committed, inputs)

  useLayoutEffect(() => {
    setCommitted((current) => resolveColdParkedPresentation(current, latestInputsRef.current))
  }, [presentationByScope])

  const settleTarget = useCallback((targetId: string) => {
    setCommitted((current) => {
      const latest = latestInputsRef.current
      const resolved = resolveColdParkedPresentation(current, latest)
      return settlePresentationTarget(resolved, latest.desiredTargetByScope, targetId)
    })
  }, [])

  useEffect(() => {
    const timers = new Set<number>()
    const pendingTargetIds = new Set(
      Array.from(presentationByScope.values(), (entry) => entry.pendingTargetId).filter(
        (targetId): targetId is string => targetId !== null
      )
    )
    for (const targetId of pendingTargetIds) {
      timers.add(window.setTimeout(() => settleTarget(targetId), fallbackMs))
    }
    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer)
      }
    }
  }, [fallbackMs, presentationByScope, settleTarget])

  return { presentationByScope, settleTarget }
}
