// The failure banner's model picker: the models the editor's Agent field offers for this agent.
import React, { useId } from 'react'
import { useBotAgentMenu } from '@/components/bots/use-bot-agent-choices'
import { useAgentLaunchPickerInventory } from '@/components/agent/use-agent-launch-picker-inventory'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { agentPickerModels } from '../../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import type { AgentPickerEntry } from '../../../../../shared/agent-launch/picker/agent-launch-picker'
import { isFailedAutomationRunModel } from '../../../../../shared/automations/history/automation-run-model-failure'
import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import type { Bot, BotAgent } from '../../../../../shared/bot-types'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

import type { AutomationRunModelOption } from './automation-run-model-fix'

/** What the picker lists, or null while it can't say (still reading, failed, or nothing offered):
 *  then the banner shows no picker and Edit is the way to change the model. */
export function automationRunModelOptions(
  entries: readonly AgentPickerEntry[],
  agent: BotAgent
): AutomationRunModelOption[] | null {
  const entry = entries.find((candidate) => candidate.agent === agent)
  if (
    !entry ||
    !entry.surfaces.includes('chat') ||
    (entry.catalogRead !== undefined && entry.catalogRead !== 'settled')
  ) {
    return null
  }
  const models = agentPickerModels(entry, 'chat')
    .filter((model) => !model.hidden)
    .map((model) => ({ id: model.id, label: model.label || model.id }))
  return models.length ? models : null
}

function useAutomationRunModelOptions(
  bot: Pick<Bot, 'hostId' | 'folderWorkspaceId'>,
  agent: BotAgent
): AutomationRunModelOption[] | null {
  // As the editor's bot Agent field reads them: the bot's host menu, in the bot's folder workspace.
  const menu = useBotAgentMenu(bot.hostId, true, agent)
  const entries = useAgentLaunchPickerInventory(
    folderWorkspaceKey(bot.folderWorkspaceId),
    menu.model,
    true,
    agent
  )
  return menu.choices.includes(agent) ? automationRunModelOptions(entries, agent) : null
}

export function AutomationRunModelSelect({
  options,
  currentModel,
  failureParams,
  disabled,
  defaultOpen,
  onPick
}: {
  options: readonly AutomationRunModelOption[]
  /** Fixtures show the list open. */
  defaultOpen?: boolean
  currentModel?: string
  failureParams?: AutomationRun['errorParams']
  disabled: boolean
  onPick: (model: AutomationRunModelOption) => void
}): React.JSX.Element {
  const t = useTranslate()
  const nameId = useId()
  const valueId = useId()
  const currentLabel = options.find((option) => option.id === currentModel)?.label ?? currentModel
  const models =
    currentModel && !options.some((option) => option.id === currentModel)
      ? [{ id: currentModel, label: currentModel }, ...options]
      : options
  const historicalLabel =
    typeof failureParams?.model === 'string' &&
    !models.some((option) => isFailedAutomationRunModel(option.id, failureParams))
      ? failureParams.model
      : null
  const failedSuffix = (
    <span className="text-foreground">{t('automations.runModelFix.failed', 'Failed')}</span>
  )
  return (
    <Select
      value={currentModel ? `model:${currentModel}` : ''}
      disabled={disabled}
      defaultOpen={defaultOpen}
      onValueChange={(next) => {
        const option = options.find((candidate) => `model:${candidate.id}` === next)
        if (
          option &&
          option.id !== currentModel &&
          !isFailedAutomationRunModel(option.id, failureParams)
        ) {
          onPick(option)
        }
      }}
    >
      <SelectTrigger
        size="xs"
        variant="destructive"
        aria-labelledby={`${nameId} ${valueId}`}
        title={currentLabel}
        className="max-w-[45%] min-w-0 @max-[33rem]:max-w-none"
      >
        <span id={nameId} className="sr-only">
          {t('automations.runModelFix.model', 'Model')}
        </span>
        <SelectValue
          id={valueId}
          placeholder={t('automations.runModelFix.defaultModel', 'Default model')}
        >
          {currentLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" side="bottom" align="end">
        {historicalLabel ? (
          <SelectItem value="historical" disabled>
            {historicalLabel} {failedSuffix}
          </SelectItem>
        ) : null}
        {models.map((option) => {
          const failed = isFailedAutomationRunModel(option.id, failureParams)
          return (
            <SelectItem key={option.id} value={`model:${option.id}`} disabled={failed}>
              {option.label}
              {failed ? <> {failedSuffix}</> : null}
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

export function AutomationRunModelPicker({
  bot,
  agent,
  currentModel,
  failureParams,
  disabled,
  renderNotice,
  onPick
}: {
  bot: Pick<Bot, 'hostId' | 'folderWorkspaceId'>
  agent: BotAgent
  currentModel?: string
  failureParams?: AutomationRun['errorParams']
  disabled: boolean
  renderNotice: (picker?: React.ReactNode) => React.JSX.Element
  onPick: (model: AutomationRunModelOption) => void
}): React.JSX.Element {
  const options = useAutomationRunModelOptions(bot, agent)
  return renderNotice(
    options?.some(
      (option) =>
        option.id !== currentModel && !isFailedAutomationRunModel(option.id, failureParams)
    ) ? (
      <AutomationRunModelSelect
        options={options}
        currentModel={currentModel}
        failureParams={failureParams}
        disabled={disabled}
        onPick={onPick}
      />
    ) : undefined
  )
}
