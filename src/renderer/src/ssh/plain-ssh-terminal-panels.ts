/**
 * Which plain SSH terminal windows are open, one per host. Deliberately outside the app store and
 * the workspace session: these windows are never persisted, restored or synced.
 */
import { useSyncExternalStore } from 'react'

export type PlainSshPanel = { targetId: string; label: string; minimized: boolean }

let panels: readonly PlainSshPanel[] = []
const listeners = new Set<() => void>()

function publish(next: readonly PlainSshPanel[]): void {
  panels = next
  for (const listener of listeners) {
    listener()
  }
}

/** Shows the host's window, opening it if needed; only one is expanded at a time. */
export function showPlainSshPanel(targetId: string, label: string): void {
  const rest = panels
    .filter((panel) => panel.targetId !== targetId)
    .map((panel) => (panel.minimized ? panel : { ...panel, minimized: true }))
  const current = panels.find((panel) => panel.targetId === targetId)
  publish([...rest, { targetId, label: current?.label ?? label, minimized: false }])
}

export function minimizePlainSshPanel(targetId: string): void {
  publish(
    panels.map((panel) => (panel.targetId === targetId ? { ...panel, minimized: true } : panel))
  )
}

export function removePlainSshPanel(targetId: string): void {
  publish(panels.filter((panel) => panel.targetId !== targetId))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePlainSshPanels(): readonly PlainSshPanel[] {
  return useSyncExternalStore(subscribe, () => panels)
}
