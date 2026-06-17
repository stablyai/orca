import React from 'react'
import { Plus, Settings2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { getAgentModelInfo } from '../../../../shared/tui-agent-models'
import type { TuiAgent } from '../../../../shared/types'
import type { AutomationDraft } from './AutomationEditorDialog'
import { createAgentEnvDraftEntry, type AgentEnvDraftEntry } from './automation-agent-config-draft'

const MODEL_DEFAULT = '__default__'
const MODEL_CUSTOM = '__custom__'

type AutomationAgentConfigSectionProps = {
  agentId: TuiAgent
  draft: AutomationDraft
  triggerClassName?: string
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

function hasConfig(draft: AutomationDraft): boolean {
  return (
    draft.agentModel.trim().length > 0 ||
    draft.agentLaunchArgs.trim().length > 0 ||
    draft.agentEnv.some((entry) => entry.key.trim().length > 0)
  )
}

export function AutomationAgentConfigSection({
  agentId,
  draft,
  triggerClassName,
  onDraftChange
}: AutomationAgentConfigSectionProps): React.JSX.Element {
  const modelInfo = getAgentModelInfo(agentId)
  const curatedModels = modelInfo?.models ?? []
  const isCustomModel =
    draft.agentModel.trim().length > 0 && !curatedModels.includes(draft.agentModel)

  const setModel = (model: string): void =>
    onDraftChange((current) => ({ ...current, agentModel: model }))
  const setArgs = (agentLaunchArgs: string): void =>
    onDraftChange((current) => ({ ...current, agentLaunchArgs }))
  const updateEnv = (next: AgentEnvDraftEntry[]): void =>
    onDraftChange((current) => ({ ...current, agentEnv: next }))

  const selectValue = !draft.agentModel.trim()
    ? MODEL_DEFAULT
    : isCustomModel
      ? MODEL_CUSTOM
      : draft.agentModel

  const handleModelSelect = (value: string): void => {
    if (value === MODEL_DEFAULT) {
      setModel('')
    } else if (value === MODEL_CUSTOM) {
      // Why: switching from a curated pick to custom clears the value so the
      // free-text field starts empty rather than echoing the dropdown choice.
      setModel(isCustomModel ? draft.agentModel : '')
    } else {
      setModel(value)
    }
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('h-9 w-full justify-start gap-2 font-normal', triggerClassName)}
        >
          <Settings2 className="size-3.5" />
          {translate(
            'auto.components.automations.AutomationAgentConfigSection.configure',
            'Configure'
          )}
          {hasConfig(draft) ? (
            <span className="ml-auto size-2 rounded-full bg-primary" aria-hidden />
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-4">
        {modelInfo ? (
          <div className="space-y-1.5">
            <Label>
              {translate('auto.components.automations.AutomationAgentConfigSection.model', 'Model')}
            </Label>
            <Select value={selectValue} onValueChange={handleModelSelect}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={MODEL_DEFAULT}>
                  {translate(
                    'auto.components.automations.AutomationAgentConfigSection.modelDefault',
                    'Agent default'
                  )}
                </SelectItem>
                {curatedModels.map((model) => (
                  <SelectItem key={model} value={model}>
                    {model}
                  </SelectItem>
                ))}
                <SelectItem value={MODEL_CUSTOM}>
                  {translate(
                    'auto.components.automations.AutomationAgentConfigSection.modelCustom',
                    'Custom…'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
            {selectValue === MODEL_CUSTOM ? (
              <Input
                value={draft.agentModel}
                onChange={(event) => setModel(event.target.value)}
                placeholder={translate(
                  'auto.components.automations.AutomationAgentConfigSection.modelPlaceholder',
                  'Model name'
                )}
              />
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5">
          <Label>
            {translate(
              'auto.components.automations.AutomationAgentConfigSection.cliArgs',
              'CLI arguments'
            )}
          </Label>
          <Input
            value={draft.agentLaunchArgs}
            onChange={(event) => setArgs(event.target.value)}
            placeholder={translate(
              'auto.components.automations.AutomationAgentConfigSection.cliArgsPlaceholder',
              'Overrides the global default for this agent'
            )}
          />
        </div>

        <div className="space-y-1.5">
          <Label>
            {translate(
              'auto.components.automations.AutomationAgentConfigSection.env',
              'Environment variables'
            )}
          </Label>
          <div className="space-y-2">
            {draft.agentEnv.map((entry) => (
              <div key={entry.id} className="flex items-center gap-2">
                <Input
                  value={entry.key}
                  onChange={(event) =>
                    updateEnv(
                      draft.agentEnv.map((row) =>
                        row.id === entry.id ? { ...row, key: event.target.value } : row
                      )
                    )
                  }
                  placeholder={translate(
                    'auto.components.automations.AutomationAgentConfigSection.envKey',
                    'KEY'
                  )}
                  className="font-mono text-xs"
                />
                <Input
                  value={entry.value}
                  onChange={(event) =>
                    updateEnv(
                      draft.agentEnv.map((row) =>
                        row.id === entry.id ? { ...row, value: event.target.value } : row
                      )
                    )
                  }
                  placeholder={translate(
                    'auto.components.automations.AutomationAgentConfigSection.envValue',
                    'value'
                  )}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 text-muted-foreground"
                  aria-label={translate(
                    'auto.components.automations.AutomationAgentConfigSection.envRemove',
                    'Remove variable'
                  )}
                  onClick={() => updateEnv(draft.agentEnv.filter((row) => row.id !== entry.id))}
                >
                  <X className="size-3.5" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full gap-2 font-normal"
              onClick={() => updateEnv([...draft.agentEnv, createAgentEnvDraftEntry()])}
            >
              <Plus className="size-3.5" />
              {translate(
                'auto.components.automations.AutomationAgentConfigSection.envAdd',
                'Add variable'
              )}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
