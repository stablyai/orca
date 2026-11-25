// The failure banner's model picker: the models the editor's Agent field offers for this agent.
import React, { useId, useState } from 'react'
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
import { MiddleEllipsisLabel } from '@/components/new-workspace/run-target/MiddleEllipsisLabel'
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

/** One menu row: the label loses its middle when it doesn't fit; a failed row keeps "Failed" visible
 *  and is disabled. The full name stays in the title and in the name assistive tech reads. */
function ModelOption({
  value,
  label,
  failedText
}: {
  value: string
  label: string
  failedText?: string
}): React.JSX.Element {
  return (
    <SelectItem
      value={value}
      disabled={failedText !== undefined}
      textValue={label}
      title={label}
      className="*:[span]:last:min-w-0 *:[span]:last:flex-1"
    >
      {/* Why: the row is named by this text, so it carries the whole name; the shortened copy is
          visual only. */}
      <span className="sr-only">{label}</span>
      {/* Why: a disabled row ignores the pointer, so the label opts back in to show its title. The
          hidden copy sizes the menu by the full name, so shortening the label can't shrink the menu
          and re-shorten the label in a loop. */}
      <span
        aria-hidden="true"
        className="pointer-events-auto grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)]"
        title={label}
      >
        <MiddleEllipsisLabel text={label} />
        <span className="invisible h-0 overflow-hidden whitespace-pre">{label}</span>
      </span>
      {failedText ? <span className="shrink-0 text-foreground">{failedText}</span> : null}
    </SelectItem>
  )
}

export function AutomationRunModelSelect({
  options,
  currentModel,
  failureParams,
  disabled,
  busy = false,
  defaultOpen,
  onPick
}: {
  options: readonly AutomationRunModelOption[]
  /** Fixtures show the list open. */
  defaultOpen?: boolean
  currentModel?: string
  failureParams?: AutomationRun['errorParams']
  disabled: boolean
  /** A pick is saving: the trigger keeps focus but can't open. */
  busy?: boolean
  onPick: (model: AutomationRunModelOption) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(defaultOpen ?? false)
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
  const failedText = t('automations.runModelFix.failed', 'Failed')
  return (
    <Select
      value={currentModel ? `model:${currentModel}` : ''}
      disabled={disabled}
      // Why: natively disabling the focused trigger while saving would drop focus to the page.
      open={open && !busy}
      onOpenChange={(next) => setOpen(next && !busy)}
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
        aria-disabled={busy || undefined}
        data-automation-model-picker=""
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
      <SelectContent
        position="popper"
        side="bottom"
        align="end"
        // Why: a long model id would otherwise stretch the menu far past the run page.
        className="max-w-[min(24rem,calc(100vw-16px))]"
        data-automation-model-picker=""
      >
        {historicalLabel ? (
          <ModelOption value="historical" label={historicalLabel} failedText={failedText} />
        ) : null}
        {models.map((option) => (
          <ModelOption
            key={option.id}
            value={`model:${option.id}`}
            label={option.label}
            failedText={
              isFailedAutomationRunModel(option.id, failureParams) ? failedText : undefined
            }
          />
        ))}
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
  busy,
  renderNotice,
  onPick
}: {
  bot: Pick<Bot, 'hostId' | 'folderWorkspaceId'>
  agent: BotAgent
  currentModel?: string
  failureParams?: AutomationRun['errorParams']
  disabled: boolean
  busy?: boolean
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
        busy={busy}
        onPick={onPick}
      />
    ) : undefined
  )
}
