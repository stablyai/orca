import { useMemo, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import {
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from '../agent/use-agent-launch-picker-inventory'
import {
  buildAgentPickerLaunchOptions,
  type TabAgentLaunchOption
} from './tab-agent-launch-options'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'

/**
 * Subscribes the new-tab entry (omnibox) to the live agent picker entries inside the open menu,
 * so the catalog and seed reads that land after opening re-render it, not the tab bar.
 */
export function TabBarAgentPickerScope({
  inventory,
  children
}: {
  inventory: AgentPickerInventorySource
  children: (entries: AgentPickerEntry[], launchOptions: TabAgentLaunchOption[]) => ReactNode
}): ReactNode {
  const entries = useAgentPickerInventoryEntries(inventory)
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const launchOptions = useMemo(
    () => buildAgentPickerLaunchOptions(entries, commandOverrides),
    [entries, commandOverrides]
  )
  return children(entries, launchOptions)
}
