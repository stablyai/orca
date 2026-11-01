import { SourceControlTextActionAgentPicker } from './SourceControlTextActionAgentPicker'
import type {
  SourceControlAiSettings,
  SourceControlAiModelChoice
} from '../../../../shared/source-control-ai-types'
import {
  useAgentPickerDraftScope,
  invalidateAgentPickerDrafts
} from '../agent/AgentLaunchSetupButton'
import { canonicalSourceControlActionSelection } from '../../../../shared/source-control-action-selection'
import type { ActionArgumentChoices } from '../../../../shared/source-control-action-argument-choices'
import { SourceControlActionAgentPicker } from './SourceControlActionAgentPicker'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { CustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import {
  SOURCE_CONTROL_ACTION_LABELS,
  type SourceControlActionRecipe,
  type AiActionId,
  type SourceControlActionLaunchPreferences
} from '../../../../shared/source-control-ai-actions'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import type { ActionRecipeDraftValue } from './source-control-ai-action-recipe-draft'
import {
  getActionDescriptions,
  AI_TEXT_ACTION_ID_SET,
  getSourceControlActionAgentSupportText,
  getSourceControlActionAgentWarningText,
  getSourceControlAgentArgsPlaceholder
} from './source-control-action-recipe-options'
import { translate } from '@/i18n/i18n'
import { SourceControlActionOptionField } from './SourceControlActionOptionField'

const DEFAULT_AGENT_VALUE = '__default_agent__'

type SourceControlActionRecipeRowProps<ActionId extends AiActionId> = {
  actionId: ActionId
  source?: SourceControlAiSettings
  onTextModelChoiceChange?: (
    actionId: ActionId,
    choice: SourceControlAiModelChoice | undefined,
    agentArgs: string
  ) => void
  setupDiscardSignal?: number
  selectedAgent: TuiAgent | CustomAgentId | null
  draftValue: ActionRecipeDraftValue
  baseValue: ActionRecipeDraftValue
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
  isSavingTemplate: boolean
  hasUnsavedChanges?: boolean
  defaultAgentLabel?: string
  defaultAgentSupportText?: string
  defaultAgentArgsPlaceholder?: string
  repoOverrideNote?: React.ReactNode
  onAgentChange: (
    actionId: ActionId,
    value: string,
    choice?: Pick<SourceControlActionRecipe, 'surface'>
  ) => void
  surface?: SourceControlActionRecipe['surface']
  /** Launch actions only, for chats and terminals alike; text actions run headless through CLI arguments. */
  launchPreferences?: SourceControlActionLaunchPreferences
  onLaunchPreferencesChange?: (
    actionId: ActionId,
    value: SourceControlActionLaunchPreferences | undefined,
    userArgs?: string,
    argumentChoices?: ActionArgumentChoices | null
  ) => void
  onTemplateChange: (actionId: ActionId, value: string) => void
  onAgentArgsChange: (actionId: ActionId, value: string, commit?: boolean) => void
  onAppendVariable: (actionId: ActionId, variable: string) => void
  onDiscard: (actionId: ActionId) => void
  onSave: (actionId: ActionId) => void
}

function resolveAgentArgsPlaceholderAgent(
  selectedAgent: TuiAgent | CustomAgentId | null | undefined,
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
): TuiAgent | null {
  if (selectedAgent && !isCustomAgentId(selectedAgent)) {
    return selectedAgent
  }
  return defaultTuiAgent && defaultTuiAgent !== 'blank' ? defaultTuiAgent : null
}

function getActionLabel(actionId: AiActionId): string {
  return actionId === 'conversationName'
    ? translate('settings.chat.names.recipe', 'Chat name')
    : SOURCE_CONTROL_ACTION_LABELS[actionId]
}

export function SourceControlActionRecipeRow<ActionId extends AiActionId>({
  actionId,
  source,
  onTextModelChoiceChange,
  setupDiscardSignal,
  selectedAgent,
  draftValue,
  baseValue,
  defaultTuiAgent,
  isSavingTemplate,
  hasUnsavedChanges,
  defaultAgentLabel,
  defaultAgentSupportText,
  defaultAgentArgsPlaceholder,
  repoOverrideNote,
  onAgentChange,
  surface,
  launchPreferences,
  onLaunchPreferencesChange,
  onTemplateChange,
  onAgentArgsChange,
  onAppendVariable,
  onDiscard,
  onSave
}: SourceControlActionRecipeRowProps<ActionId>): React.JSX.Element {
  const draftScope = useAgentPickerDraftScope(setupDiscardSignal)
  const isLaunchAction = !AI_TEXT_ACTION_ID_SET.has(actionId)
  const templateDirty =
    hasUnsavedChanges ?? JSON.stringify(draftValue) !== JSON.stringify(baseValue)
  const agentArgsPlaceholder =
    (!selectedAgent && defaultAgentArgsPlaceholder) ||
    getSourceControlAgentArgsPlaceholder(
      resolveAgentArgsPlaceholderAgent(selectedAgent, defaultTuiAgent)
    )
  const agentWarningText = getSourceControlActionAgentWarningText(actionId, selectedAgent)
  const agentSupportText =
    (!selectedAgent && defaultAgentSupportText) || getSourceControlActionAgentSupportText(actionId)

  return (
    <div className="rounded-md border border-border px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium text-foreground">{getActionLabel(actionId)}</p>
          <p className="text-[11px] text-muted-foreground">{getActionDescriptions()[actionId]}</p>
        </div>
        <div className="w-full shrink-0 space-y-1 sm:w-[220px]">
          {isLaunchAction ? (
            <SourceControlActionAgentPicker
              draftScope={draftScope}
              agent={selectedAgent && !isCustomAgentId(selectedAgent) ? selectedAgent : null}
              surface={surface}
              disabled={isSavingTemplate}
              selection={canonicalSourceControlActionSelection({
                ...draftValue,
                agentId: selectedAgent,
                surface,
                launchPreferences
              })}
              onSetupPick={(selection, previous, argumentsAuthored) =>
                onLaunchPreferencesChange?.(
                  actionId,
                  selection.source.authoredPreferences,
                  argumentsAuthored || selection.current.agentArgs !== previous.current.agentArgs
                    ? selection.current.agentArgs
                    : undefined,
                  selection.current.argumentChoices !== previous.current.argumentChoices
                    ? (selection.current.argumentChoices ?? null)
                    : undefined
                )
              }
              onPick={(agent, choice) =>
                onAgentChange(actionId, agent ?? DEFAULT_AGENT_VALUE, choice)
              }
            />
          ) : (
            <SourceControlTextActionAgentPicker
              actionId={actionId}
              agent={selectedAgent}
              source={source}
              draft={draftValue}
              draftScope={draftScope}
              disabled={isSavingTemplate}
              defaultAgentLabel={defaultAgentLabel}
              onAgentChange={(value) => onAgentChange(actionId, value)}
              onChange={(choice, agentArgs) =>
                onTextModelChoiceChange?.(actionId, choice, agentArgs)
              }
            />
          )}
          {agentWarningText ? (
            <p className="text-[11px] text-destructive">{agentWarningText}</p>
          ) : agentSupportText ? (
            <p className="text-[11px] text-muted-foreground">{agentSupportText}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid min-w-0 grid-cols-1 items-start gap-3">
        {!isLaunchAction ? (
          <SourceControlActionOptionField
            label={translate('auto.components.settings.AgentsPane.cfb3f35775', 'Arguments')}
          >
            <Input
              value={draftValue.agentArgs ?? ''}
              spellCheck={false}
              placeholder={agentArgsPlaceholder}
              onChange={(event) => onAgentArgsChange(actionId, event.target.value)}
              variant="code"
              className="h-8"
            />
          </SourceControlActionOptionField>
        ) : null}
        <div className="min-w-0 space-y-2">
          <Label variant="settings">
            {translate(
              'auto.components.settings.SourceControlAiActionRecipeDefaults.fb09da4345',
              'Command template'
            )}
          </Label>
          <textarea
            value={draftValue.commandInputTemplate}
            rows={3}
            spellCheck={false}
            onChange={(event) => onTemplateChange(actionId, event.target.value)}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          <SourceControlActionVariableChips
            actionId={actionId}
            onInsert={(variable) => onAppendVariable(actionId, variable)}
          />
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {repoOverrideNote}
        <div className="flex items-center justify-between gap-3">
          <p className="text-[11px] text-muted-foreground">
            {templateDirty
              ? translate(
                  'auto.components.settings.SourceControlAiActionRecipeDefaults.817128d94e',
                  'Unsaved changes'
                )
              : translate(
                  'auto.components.settings.SourceControlAiActionRecipeDefaults.9d3cc627f8',
                  'Saved'
                )}
          </p>
          <div className="flex items-center gap-2">
            {templateDirty ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => {
                  invalidateAgentPickerDrafts(draftScope)
                  onDiscard(actionId)
                }}
                disabled={isSavingTemplate}
              >
                {translate(
                  'auto.components.settings.SourceControlAiActionRecipeDefaults.b3914ecbbc',
                  'Discard'
                )}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              onClick={() => onSave(actionId)}
              disabled={!templateDirty || isSavingTemplate}
            >
              {isSavingTemplate
                ? translate(
                    'auto.components.settings.SourceControlAiActionRecipeDefaults.4f549a5fa8',
                    'Saving...'
                  )
                : translate(
                    'auto.components.settings.SourceControlAiActionRecipeDefaults.d18d665e12',
                    'Save'
                  )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
