import type {
  PanelLayout,
  PanelTreeGroup,
  PinnedTerminalPanel,
  PinnedWebPanel
} from '../../../shared/types'
import { panelTreeGroupPath } from '../../../shared/panel-tree'
import { isWorktreePaletteQueryTooLarge } from './worktree-palette-query-bounds'

export type PanelPaletteKind = 'web' | 'terminal' | 'layout'

export type PanelPaletteSearchResult = {
  id: string
  kind: PanelPaletteKind
  /** Target panel or layout id. */
  targetId: string
  title: string
  /** Group path / host / url / command for subtitle. */
  subtitle: string
  score: number
}

function includesQuery(haystack: string, q: string): boolean {
  return haystack.toLowerCase().includes(q)
}

/**
 * Query-gated search over pinned panels and saved layouts for Cmd+J.
 * Empty / oversized queries return no panel rows (avoids dumping the fleet
 * list on every palette open).
 */
export function searchPanelPaletteResults(input: {
  query: string
  webPanels: readonly PinnedWebPanel[]
  terminalPanels: readonly PinnedTerminalPanel[]
  layouts: readonly PanelLayout[]
  /** Optional: resolves a panel's groupId to a readable path. Panels created
   *  from the sidebar quick-add only carry groupId, never the legacy label. */
  groups?: readonly PanelTreeGroup[]
}): PanelPaletteSearchResult[] {
  const trimmed = input.query.trim()
  if (trimmed.length === 0 || isWorktreePaletteQueryTooLarge(trimmed)) {
    return []
  }
  const q = trimmed.toLowerCase()
  const results: PanelPaletteSearchResult[] = []

  for (const panel of input.webPanels) {
    const host = (() => {
      try {
        return new URL(panel.url).host
      } catch {
        return panel.url
      }
    })()
    const groupPath = panelTreeGroupPath(input.groups ?? [], panel.groupId)
    const where = ['User Panels', ...groupPath].join(' / ')
    const hay = `${panel.title} ${host} ${panel.url} ${where}`
    if (!includesQuery(hay, q)) {
      continue
    }
    const titleHit = includesQuery(panel.title, q)
    results.push({
      id: `pinned-web-panel:${panel.id}`,
      kind: 'web',
      targetId: panel.id,
      title: panel.title,
      subtitle: `${where} · ${host}`,
      score: titleHit ? 0 : 1
    })
  }

  for (const panel of input.terminalPanels) {
    if (panel.enabled === false) {
      continue
    }
    const host = panel.host ?? 'local'
    // Why: groupId is the source of truth post-migration; the legacy `group`
    // label only exists on panels created before the tree (or via Settings).
    const groupPath = panelTreeGroupPath(input.groups ?? [], panel.groupId)
    const segments = groupPath.length > 0 ? groupPath : panel.group ? [panel.group] : []
    const path = ['Nodes', ...segments].join(' / ')
    const hay = `${panel.title} ${panel.command} ${host} ${path}`
    if (!includesQuery(hay, q)) {
      continue
    }
    const titleHit = includesQuery(panel.title, q)
    results.push({
      id: `pinned-terminal-panel:${panel.id}`,
      kind: 'terminal',
      targetId: panel.id,
      title: panel.title,
      subtitle: `${path} · ${host} · ${panel.command}`,
      score: titleHit ? 0 : 1
    })
  }

  for (const layout of input.layouts) {
    const hay = `${layout.title} layout layouts canvas`
    if (!includesQuery(hay, q)) {
      continue
    }
    results.push({
      id: `panel-layout:${layout.id}`,
      kind: 'layout',
      targetId: layout.id,
      title: layout.title,
      subtitle: 'Layouts',
      score: includesQuery(layout.title, q) ? 0 : 1
    })
  }

  results.sort((a, b) => {
    if (a.score !== b.score) {
      return a.score - b.score
    }
    return a.title.localeCompare(b.title)
  })
  return results
}
