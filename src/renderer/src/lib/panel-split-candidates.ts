import type { PinnedTerminalPanel, PinnedWebPanel } from '../../../shared/types'
import type { PanelCanvasLeaf } from './panel-canvas'

/** What a split picker entry should mint when selected. */
export type PanelSplitChoice =
  | { type: 'panel'; kind: 'terminal' | 'web'; panelId: string }
  | { type: 'blank-shell'; host: string | null; label?: string }
  | { type: 'blank-browser'; url?: string; label?: string }
  | { type: 'duplicate' }

export type PanelSplitMenuItem = {
  id: string
  label: string
  subtitle?: string
  choice: PanelSplitChoice
}

export type SplitSourceContext =
  | PanelCanvasLeaf
  | { kind: 'terminal' | 'web'; panelId: string; host?: string | null }

function sourcePanelId(source: SplitSourceContext): string | null {
  if (source.kind === 'terminal' || source.kind === 'web') {
    return source.panelId
  }
  return null
}

/** Host for filtering terminal candidates: shell leaf host, terminal panel host, else null (local). */
export function resolveSplitSourceHost(
  source: SplitSourceContext,
  terminalPanels: readonly PinnedTerminalPanel[]
): string | null {
  if (source.kind === 'shell') {
    return source.host
  }
  if (source.kind === 'browser') {
    return null
  }
  if (source.kind === 'terminal') {
    if ('host' in source && source.host !== undefined) {
      return source.host ?? null
    }
    return terminalPanels.find((panel) => panel.id === source.panelId)?.host ?? null
  }
  return null
}

/**
 * Build split-picker rows: other panels (same host for terminals), blank
 * surface, optional last "duplicate session" (policy A second process).
 * Never lists the current panel as a primary row — that is only via duplicate.
 */
export function buildSplitCandidates(input: {
  source: SplitSourceContext
  terminalPanels: readonly PinnedTerminalPanel[]
  webPanels: readonly PinnedWebPanel[]
  includeDuplicate?: boolean
}): PanelSplitMenuItem[] {
  const { source, terminalPanels, webPanels, includeDuplicate = true } = input
  const selfId = sourcePanelId(source)
  const items: PanelSplitMenuItem[] = []

  if (source.kind === 'web' || source.kind === 'browser') {
    for (const panel of webPanels) {
      if (panel.id === selfId) {
        continue
      }
      let hostLabel = panel.url
      try {
        hostLabel = new URL(panel.url).host
      } catch {
        // keep raw url
      }
      items.push({
        id: `web:${panel.id}`,
        label: panel.title,
        subtitle: hostLabel,
        choice: { type: 'panel', kind: 'web', panelId: panel.id }
      })
    }
    items.push({
      id: 'blank-browser',
      label: 'Blank browser',
      subtitle: 'about:blank',
      choice: { type: 'blank-browser' }
    })
  } else {
    // terminal | shell — same-host terminal panels + blank shell on that host
    const host = resolveSplitSourceHost(source, terminalPanels)
    for (const panel of terminalPanels) {
      if (panel.id === selfId) {
        continue
      }
      if (panel.enabled === false) {
        continue
      }
      const panelHost = panel.host ?? null
      if (panelHost !== host) {
        continue
      }
      items.push({
        id: `terminal:${panel.id}`,
        label: panel.title,
        subtitle: panel.command,
        choice: { type: 'panel', kind: 'terminal', panelId: panel.id }
      })
    }
    const shellLabel = host === null ? 'Blank local terminal' : `Blank terminal on ${host}`
    items.push({
      id: 'blank-shell',
      label: shellLabel,
      subtitle: host ?? 'local',
      choice: {
        type: 'blank-shell',
        host,
        label: host ?? 'Local shell'
      }
    })
  }

  if (
    includeDuplicate &&
    (source.kind === 'terminal' ||
      source.kind === 'web' ||
      source.kind === 'shell' ||
      source.kind === 'browser')
  ) {
    items.push({
      id: 'duplicate',
      label: 'Duplicate this tile',
      subtitle: 'Same content, new session',
      choice: { type: 'duplicate' }
    })
  }

  return items
}
