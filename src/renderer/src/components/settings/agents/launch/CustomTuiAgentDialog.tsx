import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { useTranslate } from '@/i18n/use-translate'
import type { CustomTuiAgent } from '../../../../../../shared/agent-launch/catalog/custom-tui-agents'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  isTuiAgent,
  TUI_AGENT_CONFIG
} from '../../../../../../shared/agent-launch/catalog/tui-agent-config'

export function CustomTuiAgentDialog({
  mode,
  initial,
  settingsCommands,
  onOpenChange,
  onSave
}: {
  mode: 'add' | 'edit'
  initial: CustomTuiAgent
  /** Settings → Agents commands, shown while the command field is empty. */
  settingsCommands: Partial<Record<TuiAgent, string>> | undefined
  onOpenChange: (open: boolean) => void
  onSave: (agent: CustomTuiAgent) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [draft, setDraft] = useState(initial)
  const nameId = useId()
  const agentId = useId()
  const commandId = useId()
  const commandHintId = useId()
  const name = draft.name.trim()
  const command = draft.command.trim()
  const canSave = name.length > 0 && command.length > 0
  const save = (): void => {
    if (canSave) {
      onSave({ ...draft, name, command })
    }
  }
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {mode === 'edit'
              ? t('settings.agents.customAgents.editTitle', 'Edit custom agent')
              : t('settings.agents.customAgents.addTitle', 'Add custom agent')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'settings.agents.customAgents.dialogDescription',
              'It launches like its base agent, with your command in place of the base agent’s.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor={nameId}>{t('settings.agents.customAgents.name', 'Name')}</Label>
            <Input
              id={nameId}
              autoFocus
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor={agentId}>
              {t('settings.agents.customAgents.baseAgent', 'Base agent')}
            </Label>
            <Select
              value={draft.agent}
              onValueChange={(value) => {
                if (isTuiAgent(value)) {
                  setDraft({ ...draft, agent: value })
                }
              }}
            >
              <SelectTrigger id={agentId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {getAgentCatalog().map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    <AgentIcon agent={entry.id} size={14} />
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor={commandId}>
              {t('settings.agents.customAgents.command', 'Command')}
            </Label>
            <Input
              id={commandId}
              value={draft.command}
              placeholder={
                settingsCommands?.[draft.agent]?.trim() || TUI_AGENT_CONFIG[draft.agent].launchCmd
              }
              spellCheck={false}
              autoComplete="off"
              aria-describedby={commandHintId}
              variant="code"
              onChange={(event) => setDraft({ ...draft, command: event.target.value })}
            />
            <p id={commandHintId} className="text-xs text-muted-foreground">
              {t(
                'settings.agents.customAgents.commandHint',
                'Runs instead of the base agent’s command, such as a wrapper that sets its API endpoint and execs it. Orca’s own arguments follow it.'
              )}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('settings.agents.customAgents.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!canSave}>
              {t('settings.agents.customAgents.save', 'Save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
