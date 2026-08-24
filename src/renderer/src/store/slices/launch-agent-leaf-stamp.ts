import { isTerminalLeafId } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'

/**
 * Next persisted launch-leaf pin while rebuilding a tab.
 * Drops with launchAgent so a later relaunch cannot inherit a stale leaf;
 * never overwrites an existing pin — a remaining sibling is also a sole leaf.
 */
export function resolveLaunchAgentLeafId(args: {
  launchAgent: TerminalTab['launchAgent']
  existingLeafId: TerminalTab['launchAgentLeafId']
  previousLayout: TerminalLayoutSnapshot | undefined
  nextLayout: TerminalLayoutSnapshot
}): string | undefined {
  if (!args.launchAgent) {
    return undefined
  }
  if (args.existingLeafId) {
    return args.existingLeafId
  }
  return soleLeafIdOnFirstLayout(args.previousLayout, args.nextLayout)
}

/**
 * Bind tab-scoped launchAgent to the first sole leaf the layout describes.
 * Later topologies must not overwrite it — a remaining sibling after a close
 * is also a sole leaf, and inheriting would recycle the launched identity.
 */
export function stampLaunchAgentLeafIdOnFirstLayout(args: {
  tabs: readonly TerminalTab[]
  tabId: string
  previousLayout: TerminalLayoutSnapshot | undefined
  nextLayout: TerminalLayoutSnapshot
}): TerminalTab[] | null {
  const tabIndex = args.tabs.findIndex((tab) => tab.id === args.tabId)
  const tab = args.tabs[tabIndex]
  const launchAgentLeafId = resolveLaunchAgentLeafId({
    launchAgent: tab?.launchAgent,
    existingLeafId: tab?.launchAgentLeafId,
    previousLayout: args.previousLayout,
    nextLayout: args.nextLayout
  })
  if (!tab || !launchAgentLeafId || launchAgentLeafId === tab.launchAgentLeafId) {
    return null
  }
  const nextTabs = [...args.tabs]
  nextTabs[tabIndex] = { ...tab, launchAgentLeafId }
  return nextTabs
}

/** Moves launch provenance with a detached leaf without overwriting existing target ownership. */
export function transferLaunchAgentLeafStampOnDetach(args: {
  tabs: readonly TerminalTab[]
  sourceTabId: string
  targetTabId: string
  detachedLeafId: string
}): TerminalTab[] | null {
  const sourceIndex = args.tabs.findIndex((tab) => tab.id === args.sourceTabId)
  const targetIndex = args.tabs.findIndex((tab) => tab.id === args.targetTabId)
  const source = args.tabs[sourceIndex]
  const target = args.tabs[targetIndex]
  if (
    !source?.launchAgent ||
    source.launchAgentLeafId !== args.detachedLeafId ||
    !target ||
    target.launchAgent ||
    target.launchAgentLeafId
  ) {
    return null
  }

  const sourceWithoutLaunchProvenance = { ...source }
  delete sourceWithoutLaunchProvenance.launchAgent
  delete sourceWithoutLaunchProvenance.launchAgentLeafId
  const nextTabs = [...args.tabs]
  nextTabs[sourceIndex] = sourceWithoutLaunchProvenance
  nextTabs[targetIndex] = {
    ...target,
    launchAgent: source.launchAgent,
    launchAgentLeafId: args.detachedLeafId
  }
  return nextTabs
}

function soleLeafIdOnFirstLayout(
  previousLayout: TerminalLayoutSnapshot | undefined,
  nextLayout: TerminalLayoutSnapshot
): string | undefined {
  if (previousLayout?.root) {
    return undefined
  }
  const nextRoot = nextLayout.root
  if (nextRoot?.type !== 'leaf' || !isTerminalLeafId(nextRoot.leafId)) {
    return undefined
  }
  return nextRoot.leafId
}
