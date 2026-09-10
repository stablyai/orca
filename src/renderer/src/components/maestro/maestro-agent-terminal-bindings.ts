import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

export type TerminalSurface = { surfaceId: string; paneKey: string; title: string }

export function maestroTerminalSurfacePaneKey(surface: WorkspaceSurface): string | null {
  if (surface.binding.kind !== 'terminal') {
    return null
  }
  const parsed = parsePaneKey(surface.binding.pane_key)
  if (parsed?.tabId === surface.binding.terminal_tab_id) {
    return surface.binding.pane_key
  }
  if (surface.binding.pane_key.includes(':')) {
    return null
  }
  return `${surface.binding.terminal_tab_id}:${surface.binding.pane_key}`
}

export function terminalSurfaces(
  surfaces: Readonly<Record<string, WorkspaceSurface>>
): TerminalSurface[] {
  return Object.entries(surfaces)
    .flatMap(([surfaceId, surface]) => {
      const paneKey = maestroTerminalSurfacePaneKey(surface)
      return paneKey ? [{ surfaceId, paneKey, title: surface.title }] : []
    })
    .sort((left, right) => left.surfaceId.localeCompare(right.surfaceId))
}

export function uniqueCandidateValues(
  candidates: ReadonlyMap<string, ReadonlySet<string>>
): Map<string, string> {
  return new Map(
    [...candidates.entries()].flatMap(([key, values]) =>
      values.size === 1 ? [[key, [...values][0]!] as const] : []
    )
  )
}

export function uniqueSurfaceByPaneKey(terminals: readonly TerminalSurface[]): Map<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const terminal of terminals) {
    const surfaceIds = candidates.get(terminal.paneKey) ?? new Set<string>()
    surfaceIds.add(terminal.surfaceId)
    candidates.set(terminal.paneKey, surfaceIds)
  }
  return uniqueCandidateValues(candidates)
}

export function uniqueSurfaceByTerminalHandle(
  terminals: readonly TerminalSurface[],
  terminalHandleByPaneKey: Readonly<Record<string, string | undefined>>
): Map<string, string> {
  const candidates = new Map<string, Set<string>>()
  for (const terminal of terminals) {
    const handle = terminalHandleByPaneKey[terminal.paneKey]
    if (!handle) {
      continue
    }
    const surfaceIds = candidates.get(handle) ?? new Set<string>()
    surfaceIds.add(terminal.surfaceId)
    candidates.set(handle, surfaceIds)
  }
  return uniqueCandidateValues(candidates)
}
