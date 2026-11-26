import { AgentSettingsMenuItem } from '@/components/agent/AgentSettingsMenuItem'
import { useAppStore } from '@/store'

/** Opens Settings › Agents; ends every agent list in the + menu. */
export function OpenAgentSettingsMenuItem({
  variant
}: {
  variant?: 'launch' | 'create'
}): React.JSX.Element {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  return (
    <AgentSettingsMenuItem
      variant={variant}
      onSelect={() => {
        openSettingsTarget({ pane: 'agents', repoId: null })
        openSettingsPage()
      }}
    />
  )
}
