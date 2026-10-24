import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import {
  resolveTerminalTabTitle,
  resolveUnifiedTabLabel
} from '../../../shared/tab-title-resolution'

export function projectGroupedTerminalTab(
  item: Tab,
  terminalTab: TerminalTab | undefined,
  worktreeId: string,
  generatedTitlesEnabled: boolean
): TerminalTab & { unifiedTabId: string } {
  return {
    id: item.entityId,
    unifiedTabId: item.id,
    ptyId: terminalTab?.ptyId ?? null,
    worktreeId,
    title: resolveUnifiedTabLabel(
      {
        ...item,
        quickCommandLabel: item.quickCommandLabel ?? terminalTab?.quickCommandLabel,
        generatedLabel: item.generatedLabel ?? terminalTab?.generatedTitle
      },
      generatedTitlesEnabled,
      item.label
    ),
    defaultTitle: terminalTab?.defaultTitle,
    quickCommandLabel: terminalTab?.quickCommandLabel ?? item.quickCommandLabel ?? null,
    generatedTitle: terminalTab?.generatedTitle ?? item.generatedLabel ?? null,
    customTitle: item.customLabel ?? terminalTab?.customTitle ?? null,
    color: item.color ?? terminalTab?.color ?? null,
    sortOrder: item.sortOrder,
    createdAt: item.createdAt,
    generation: terminalTab?.generation,
    shellOverride: terminalTab?.shellOverride,
    startupCwd: terminalTab?.startupCwd,
    // Why: rebuilt from the unified-tab model, so copy store-only launchAgent or the provider icon is missing until the first hook.
    launchAgent: terminalTab?.launchAgent,
    pendingActivationSpawn: terminalTab?.pendingActivationSpawn
  }
}

export function resolveTerminalItemTab(
  tab: TerminalTab & { unifiedTabId?: string },
  generatedTitlesEnabled: boolean
): TerminalTab & { unifiedTabId?: string } {
  return { ...tab, title: resolveTerminalTabTitle(tab, generatedTitlesEnabled, tab.title) }
}
