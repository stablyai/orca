import type { RightSidebarTab } from './types'

/**
 * Every non-plugin right-sidebar tab. Lives in shared so the renderer's route
 * normalizer and the runtime RPC client schema read one list — a tab added in
 * only one of them is the drift the ui-state parity assertions exist to catch.
 * Plugin panels are open-ended `plugin:<publisher>.<id>/<panel>` keys and are
 * validated by shape instead.
 */
export const STATIC_RIGHT_SIDEBAR_TABS = [
  'explorer',
  'search',
  'vault',
  'workspaces',
  'pr-checks',
  'source-control',
  'checks',
  'ports',
  'linear'
] as const satisfies readonly Exclude<RightSidebarTab, `plugin:${string}`>[]

export type StaticRightSidebarTab = (typeof STATIC_RIGHT_SIDEBAR_TABS)[number]

export function isStaticRightSidebarTab(value: unknown): value is StaticRightSidebarTab {
  return (
    typeof value === 'string' && (STATIC_RIGHT_SIDEBAR_TABS as readonly string[]).includes(value)
  )
}

/** Static tabs a panel can actually be showing. 'search' is a legacy persisted
 *  value that resolves to Explorer's search view, never to a tab of its own. */
export function isActiveStaticRightSidebarTab(
  value: unknown
): value is Exclude<StaticRightSidebarTab, 'search'> {
  return isStaticRightSidebarTab(value) && value !== 'search'
}
