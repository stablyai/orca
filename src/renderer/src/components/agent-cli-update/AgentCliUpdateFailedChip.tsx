import { AgentCommandFailedChip } from '@/components/agent-command-failure/AgentCommandFailedChip'
import { useTranslate } from '@/i18n/use-translate'

/** Every surface's failed-update state; clicking opens the output dialog. */
export function AgentCliUpdateFailedChip({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <AgentCommandFailedChip
      label={t('agentCliUpdate.failedChip', 'update failed')}
      ariaLabel={t('agentCliUpdate.failedChipLabel', 'Update failed: view error')}
      tooltip={t('agentCliUpdate.failedChipTooltip', 'Update failed. Click to see details.')}
      onOpen={(event) => {
        // A picker row underneath would treat the click as its own retry.
        event.stopPropagation()
        onOpen()
      }}
      onPointerDown={(event) => event.stopPropagation()}
    />
  )
}
