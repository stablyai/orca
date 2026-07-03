import type { TerminalTab } from '../../../shared/types'
import { stripLeadingAgentTitleDecoration } from './agent-title-decoration'

// Why: mirror the tab bar's display-title derivation (SortableTab) so an agent
// row in tab-name mode shows the same label the user sees on the tab —
// customTitle wins, otherwise the live OSC title with the agent's leading
// status glyph stripped. Falls back to the stable default label so the row is
// never left with an empty primary text column.
export function getAgentRowTabName(tab: TerminalTab): string {
  const custom = tab.customTitle?.trim()
  if (custom) {
    return custom
  }
  const live = stripLeadingAgentTitleDecoration(tab.title ?? '').trim()
  if (live) {
    return live
  }
  return tab.defaultTitle?.trim() || tab.title?.trim() || ''
}
