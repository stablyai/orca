import { useAppStore } from '@/store'
import { resolveTerminalLinkTooltipEnabled } from '../../../../shared/terminal/links/terminal-link-tooltip-settings'

/**
 * Whether the bottom link-target preview bar may show while hovering terminal links.
 * Reads live settings so toggling applies to existing panes without remounting.
 * When disabled, link detection, clicking, and modifier-click actions still work.
 */
export function isTerminalLinkTooltipEnabled(): boolean {
  return resolveTerminalLinkTooltipEnabled(
    useAppStore.getState().settings?.terminalLinkTooltipEnabled
  )
}
