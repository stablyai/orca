import { useEffect, useRef, useState } from 'react'
import type {
  WorkspaceSurface,
  WorkspaceSurfaceSnapshot
} from '../../../../shared/maestro-workspace-canvas'

export type MaestroWorkspacePresencePhase = 'entering' | 'present' | 'exiting'

export type MaestroWorkspacePresenceItem = {
  surfaceKey: string
  surface: WorkspaceSurface
  phase: MaestroWorkspacePresencePhase
}

const ENTER_DURATION_MS = 180
const EXIT_DURATION_MS = 160

function schedulePresenceSettlement(
  duration: number,
  settle: () => void
): ReturnType<typeof setTimeout> {
  return setTimeout(settle, duration)
}

export function reconcileMaestroWorkspacePresence(
  current: readonly MaestroWorkspacePresenceItem[],
  snapshot: WorkspaceSurfaceSnapshot,
  surfaceKeys: readonly string[]
): MaestroWorkspacePresenceItem[] {
  const visibleKeys = new Set(surfaceKeys)
  const retainedKeys = new Set<string>()
  const next: MaestroWorkspacePresenceItem[] = []

  for (const existing of current) {
    const surface = snapshot.surfaces[existing.surfaceKey]
    if (!visibleKeys.has(existing.surfaceKey) || !surface) {
      next.push({ ...existing, phase: 'exiting' })
      continue
    }
    retainedKeys.add(existing.surfaceKey)
    next.push({
      surfaceKey: existing.surfaceKey,
      surface,
      phase: existing.phase === 'exiting' ? 'entering' : existing.phase
    })
  }

  for (const surfaceKey of surfaceKeys) {
    if (retainedKeys.has(surfaceKey)) {
      continue
    }
    const surface = snapshot.surfaces[surfaceKey]
    if (surface) {
      next.push({ surfaceKey, surface, phase: 'entering' })
    }
  }

  return next
}

export function settleMaestroWorkspacePresence(
  current: readonly MaestroWorkspacePresenceItem[],
  surfaceKey: string,
  phase: MaestroWorkspacePresencePhase
): MaestroWorkspacePresenceItem[] {
  if (phase === 'exiting') {
    return current.filter((item) => item.surfaceKey !== surfaceKey || item.phase !== 'exiting')
  }
  return current.map((item) =>
    item.surfaceKey === surfaceKey && item.phase === phase ? { ...item, phase: 'present' } : item
  )
}

export function transientMaestroWorkspacePresence(
  items: readonly MaestroWorkspacePresenceItem[],
  renderableSurfaceKeys: ReadonlySet<string>
): ReadonlyMap<string, Exclude<MaestroWorkspacePresencePhase, 'present'>> {
  return new Map(
    items.flatMap((item) =>
      item.phase === 'present' ||
      (item.phase === 'entering' && !renderableSurfaceKeys.has(item.surfaceKey))
        ? []
        : [[item.surfaceKey, item.phase] as const]
    )
  )
}

function initialPresenceItems(
  snapshot: WorkspaceSurfaceSnapshot,
  surfaceKeys: readonly string[]
): MaestroWorkspacePresenceItem[] {
  return surfaceKeys.flatMap((surfaceKey) => {
    const surface = snapshot.surfaces[surfaceKey]
    return surface ? [{ surfaceKey, surface, phase: 'present' as const }] : []
  })
}

export function useMaestroWorkspacePresence(
  snapshot: WorkspaceSurfaceSnapshot,
  surfaceKeys: readonly string[],
  renderableSurfaceKeys: ReadonlySet<string>
): readonly MaestroWorkspacePresenceItem[] {
  const [items, setItems] = useState(() => initialPresenceItems(snapshot, surfaceKeys))
  const timers = useRef(
    new Map<
      string,
      {
        phase: Exclude<MaestroWorkspacePresencePhase, 'present'>
        timer: ReturnType<typeof setTimeout>
      }
    >()
  )

  useEffect(() => {
    setItems((current) => reconcileMaestroWorkspacePresence(current, snapshot, surfaceKeys))
  }, [snapshot, surfaceKeys])

  useEffect(() => {
    const activeTimers = timers.current
    const transientByKey = transientMaestroWorkspacePresence(items, renderableSurfaceKeys)

    for (const [surfaceKey, entry] of activeTimers) {
      if (transientByKey.get(surfaceKey) !== entry.phase) {
        clearTimeout(entry.timer)
        activeTimers.delete(surfaceKey)
      }
    }

    for (const [surfaceKey, phase] of transientByKey) {
      if (activeTimers.has(surfaceKey)) {
        continue
      }
      const duration = phase === 'entering' ? ENTER_DURATION_MS : EXIT_DURATION_MS
      const timer = schedulePresenceSettlement(duration, () => {
        activeTimers.delete(surfaceKey)
        setItems((current) => settleMaestroWorkspacePresence(current, surfaceKey, phase))
      })
      activeTimers.set(surfaceKey, { phase, timer })
    }
    return () => {
      for (const entry of activeTimers.values()) {
        clearTimeout(entry.timer)
      }
      activeTimers.clear()
    }
  }, [items, renderableSurfaceKeys])

  return items
}
