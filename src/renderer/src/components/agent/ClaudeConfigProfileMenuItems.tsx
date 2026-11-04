import { useAppStore } from '@/store/index'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { AgentIcon } from '@/lib/agent-catalog'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { NewTabAgentMenuRow } from '../../../../shared/agent-launch/picker/agent-launch-picker-rows'
import { claudeConfigProfileRows } from '../tab-bar/claude-config-profile-rows'
import { rowId, rowLabel, rowTitle } from '../tab-bar/tab-agent-row-presentation'

/** Profile rows whose label contains every search word; none unless Claude can start in a terminal here. */
export function useClaudeConfigProfilePickerRows(
  entries: readonly AgentPickerEntry[],
  words: readonly string[]
): NewTabAgentMenuRow[] {
  const profiles = useAppStore((state) => state.settings?.claudeConfigProfiles)
  const claude = entries.find(
    (entry) => entry.agent === 'claude' && entry.surfaces.includes('terminal')
  )
  const base: NewTabAgentMenuRow | undefined = claude
    ? { agent: 'claude', kind: 'cli', executionHostId: claude.rows[0]?.executionHostId }
    : undefined
  return claudeConfigProfileRows(base, profiles).filter((row) => {
    const label = rowLabel(row).toLowerCase()
    return words.every((word) => label.includes(word))
  })
}

export function ClaudeConfigProfileMenuItems({
  rows,
  disabled,
  runLaunch
}: {
  rows: readonly NewTabAgentMenuRow[]
  disabled?: boolean
  runLaunch: (row: NewTabAgentMenuRow) => unknown
}): React.JSX.Element {
  return (
    <>
      {rows.map((row) => {
        const label = rowLabel(row)
        return (
          <DropdownMenuItem
            key={rowId(row)}
            variant="launch"
            disabled={disabled}
            title={rowTitle(row, label)}
            onSelect={() => void runLaunch(row)}
          >
            <AgentIcon agent="claude" size={14} />
            <span className="min-w-0 flex-1 truncate">{label}</span>
          </DropdownMenuItem>
        )
      })}
    </>
  )
}
