import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CommandItem } from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { agentCliProductName } from '@/components/agent-cli-update/agent-cli-product-name'
import { AgentCliUpdateFailedChip } from '@/components/agent-cli-update/AgentCliUpdateFailedChip'
import type { AgentCliModelRequirement } from '../../../../../../../shared/agent-launch/installation/agent-cli-update'
import type { SessionOptionsCliUpdate } from '../../../../../../../shared/native-chat/input/native-chat-session-options'

/** A model the chat's own CLI is too old for: listed, not pickable, with that CLI's Update. */
export function NativeChatModelNeedsCliUpdateRow({
  model,
  update
}: {
  model: AgentCliModelRequirement
  update: SessionOptionsCliUpdate
}): React.JSX.Element {
  const t = useTranslate()
  const running = update.phase === 'running'
  return (
    <CommandItem
      value={`cli-update:${model.id}`}
      keywords={[model.name]}
      selection="palette"
      // Picking it does nothing; only its Update acts.
      onSelect={() => {}}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="min-w-0 flex-1 truncate py-0.5 text-muted-foreground">{model.name}</span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {t('agentCliUpdate.modelRequires', 'Requires {{product}} {{version}}', {
            product: agentCliProductName(update.agent, t),
            version: model.minVersion
          })}
        </TooltipContent>
      </Tooltip>
      {update.runnable ? (
        <span className="flex shrink-0 items-center gap-1.5">
          {update.phase === 'failed' ? (
            <AgentCliUpdateFailedChip onOpen={update.openFailure} />
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={running}
            onClick={(event) => {
              event.stopPropagation()
              update.start()
            }}
          >
            {running ? <Loader2 className="animate-spin" /> : null}
            {running
              ? t('agentCliUpdate.updating', 'Updating…')
              : update.phase === 'failed'
                ? t('agentCliUpdate.tryAgain', 'Try again')
                : t('agentCliUpdate.update', 'Update')}
          </Button>
        </span>
      ) : null}
    </CommandItem>
  )
}
