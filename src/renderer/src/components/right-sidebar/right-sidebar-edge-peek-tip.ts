import type { GlobalSettings } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import {
  getRightSidebarEdgePeekEntry,
  RIGHT_SIDEBAR_EDGE_PEEK_SETTING_ID
} from '@/components/settings/appearance-sidebar-search'
import {
  isRightSidebarEdgePeekEnabled,
  isRightSidebarEdgePeekTipDismissed
} from './right-sidebar-edge-peek-preference'

/** How long the one-shot edge-peek hint stays visible (long enough to read). */
export const RIGHT_SIDEBAR_EDGE_PEEK_TIP_VISIBLE_MS = 2500

export { RIGHT_SIDEBAR_EDGE_PEEK_SETTING_ID }

type TipSettings = Pick<
  GlobalSettings,
  'rightSidebarEdgePeekEnabled' | 'rightSidebarEdgePeekTipDismissed'
> | null

export function shouldShowRightSidebarEdgePeekTip(settings: TipSettings): boolean {
  return isRightSidebarEdgePeekEnabled(settings) && !isRightSidebarEdgePeekTipDismissed(settings)
}

export function markRightSidebarEdgePeekTipDismissed(args: {
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
}): void {
  void Promise.resolve(args.updateSettings({ rightSidebarEdgePeekTipDismissed: true })).catch(
    () => {}
  )
}

export function getRightSidebarEdgePeekTipTitle(): string {
  // Why: new key so older locale catalog rows for the short "to peek" title
  // don't override this longer, more specific copy.
  return translate(
    'auto.components.right.sidebar.edge.peek.tip.titleLong',
    'Hover over the right edge of the screen to quickly show this sidebar.'
  )
}

export function getRightSidebarEdgePeekTipSettingsPrefix(): string {
  return translate('auto.components.right.sidebar.edge.peek.tip.settingsPrefix', 'Turn this off in')
}

/** Short clickable label; the target is still the edge-peek Appearance row. */
export function getRightSidebarEdgePeekSettingsLinkLabel(): string {
  return translate('auto.components.right.sidebar.edge.peek.tip.settingsLink', 'Settings')
}

/** Opens Appearance and scrolls/highlights the edge-peek switch. */
export function openRightSidebarEdgePeekSetting(args: {
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: 'appearance'; repoId: null; sectionId: string }) => void
  setSettingsSearchQuery: (query: string) => void
}): void {
  // Why: seed search so Appearance's Advanced disclosure force-opens (the switch
  // lives under Advanced and is unmounted when collapsed).
  args.setSettingsSearchQuery(getRightSidebarEdgePeekEntry().title)
  args.openSettingsTarget({
    pane: 'appearance',
    repoId: null,
    sectionId: RIGHT_SIDEBAR_EDGE_PEEK_SETTING_ID
  })
  args.openSettingsPage()
}
