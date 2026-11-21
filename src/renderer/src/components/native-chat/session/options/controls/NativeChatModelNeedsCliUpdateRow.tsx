import { AlertCircle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CommandItem } from '@/components/ui/command'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
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
      {/* Spans the row so the tooltip centers on it; cmdk's item replaces a trigger's own pointer handlers. */}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 flex-1 truncate py-0.5 text-muted-foreground">
              {model.name}
            </span>
            {update.runnable ? (
              update.phase === 'failed' ? (
                // One control in the Update slot; the dialog it opens has Try again.
                <Button
                  type="button"
                  variant="destructive-chip"
                  size="xs"
                  aria-label={t('agentCliUpdate.failedChipLabel', 'Update failed: view error')}
                  onClick={(event) => {
                    event.stopPropagation()
                    update.openFailure()
                  }}
                >
                  <AlertCircle />
                  {t('agentCliUpdate.failedButton', 'Update failed')}
                </Button>
              ) : (
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
                    : t('agentCliUpdate.update', 'Update')}
                </Button>
              )
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {update.agent === 'claude'
            ? t('agentCliUpdate.modelRequiresClaude', 'Requires Claude Code CLI {{version}}', {
                version: model.minVersion
              })
            : t('agentCliUpdate.modelRequiresCodex', 'Requires Codex CLI {{version}}', {
                version: model.minVersion
              })}
        </TooltipContent>
      </Tooltip>
    </CommandItem>
  )
}
