// The picked agent itself, or one of its saved copies with their own launch setup.
import { useTranslate } from '@/i18n/use-translate'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { useAgentCopiesForMenu } from '@/components/agent/launch-menu/AgentCopyMenuItems'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'

export function ComposerAgentCopyChoice({
  agent,
  value,
  onChange
}: {
  agent: TuiAgent
  value: string | null
  onChange: (copyId: string | null) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const copies = useAgentCopiesForMenu().filter((copy) => copy.agent === agent)
  if (copies.length === 0) {
    return null
  }
  const label = getAgentCatalog().find((entry) => entry.id === agent)?.label ?? agent
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={t('components.newWorkspace.runsAs', 'Runs as')}
      value={value ?? agent}
      // A copy id has a dot, so the agent's own id never reads as one.
      onValueChange={(next) => onChange(next && next !== agent ? next : null)}
      className="flex-wrap justify-start"
    >
      <ToggleGroupItem value={agent}>{label}</ToggleGroupItem>
      {copies.map((copy) => (
        <ToggleGroupItem key={copy.id} value={copy.id} title={copy.id}>
          {copy.name}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}
