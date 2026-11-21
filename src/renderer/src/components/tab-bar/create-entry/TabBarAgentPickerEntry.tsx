import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import {
  useAgentPickerInventoryEntries,
  type AgentPickerInventorySource
} from '../../agent/agent-picker-inventory-source'
import { buildAgentPickerLaunchOptions } from './tab-agent-launch-options'
import { useAgentPickerEntriesWithCopies } from '../../agent/launch-menu/AgentCopyMenuItems'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import TabBarCreateEntry from './TabBarCreateEntry'
import type { TabBarCreateEntryProps } from './tab-create-entry-props'

// Subscribe inside the menu so inventory updates do not re-render the tab bar.
export function TabBarAgentPickerEntry({
  inventory,
  detectedIds = null,
  hideAgents = false,
  ...props
}: Omit<TabBarCreateEntryProps, 'agentPickerEntries' | 'agentOptions'> & {
  inventory: AgentPickerInventorySource
  /** Detected CLIs, for the copies listed after their base agents. */
  detectedIds?: readonly TuiAgent[] | null
  hideAgents?: boolean
}): React.JSX.Element {
  const entries = useAgentPickerEntriesWithCopies(
    useAgentPickerInventoryEntries(inventory),
    detectedIds
  )
  const commandOverrides = useAppStore((state) => state.settings?.agentCmdOverrides)
  const launchOptions = useMemo(
    () => buildAgentPickerLaunchOptions(entries, commandOverrides),
    [entries, commandOverrides]
  )
  return hideAgents ? (
    <TabBarCreateEntry {...props} />
  ) : (
    <TabBarCreateEntry {...props} agentPickerEntries={entries} agentOptions={launchOptions} />
  )
}
