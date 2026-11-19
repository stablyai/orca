import { Download, Loader2 } from 'lucide-react'
import { CommandGroup, CommandItem, CommandSeparator } from '@/components/ui/command'
import { useTranslate } from '@/i18n/use-translate'
import { agentCliProductName } from '@/components/agent-cli-update/agent-cli-product-name'
import { AgentCliUpdateFailedChip } from '@/components/agent-cli-update/AgentCliUpdateFailedChip'
import type { SessionOptionsCliUpdate } from '../../../../../../../shared/native-chat/input/native-chat-session-options'

/** Only for the user's own CLI behind its latest release; Orca's own copy updates by itself. */
export function NativeChatModelCliUpdateRow({
  update
}: {
  update: SessionOptionsCliUpdate | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  if (!update) {
    return null
  }
  const running = update.phase === 'running'
  return (
    <>
      <CommandSeparator />
      <CommandGroup>
        <CommandItem
          value="__cli-update__"
          selection="palette"
          disabled={running}
          onSelect={update.start}
        >
          <span className="truncate">
            {t('agentCliUpdate.modelPickerRow', 'Update {{product}} for new models', {
              product: agentCliProductName(update.agent, t)
            })}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            {running ? (
              <>
                {t('agentCliUpdate.updating', 'Updating…')}
                <Loader2 className="size-3.5 animate-spin" />
              </>
            ) : update.phase === 'failed' ? (
              <AgentCliUpdateFailedChip onOpen={update.openFailure} />
            ) : (
              <Download className="size-3.5" />
            )}
          </span>
        </CommandItem>
      </CommandGroup>
    </>
  )
}
