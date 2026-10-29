import { sourceControlActionSelectedPreferences } from '../../../../shared/source-control-action-launch-preferences'
import type { ActionArgumentChoices } from '../../../../shared/source-control-action-argument-choices'
import { SourceControlActionAgentPicker } from './SourceControlActionAgentPicker'
import { SourceControlActionArguments } from './SourceControlActionArguments'
import { Terminal } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { CustomAgentId } from '../../../../shared/commit-message-agent-spec'
import { CUSTOM_AGENT_ID, isCustomAgentId } from '../../../../shared/commit-message-agent-spec'
import {
  SOURCE_CONTROL_ACTION_LABELS,
  type SourceControlActionRecipe,
  type AiActionId,
  type SourceControlActionLaunchPreferences
} from '../../../../shared/source-control-ai-actions'
import { AgentIcon } from '@/lib/agent-catalog'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import type { ActionRecipeDraftValue } from './source-control-ai-action-recipe-draft'
import {
  getActionDescriptions,
  AI_TEXT_ACTION_ID_SET,
  getAgentCatalogForAction,
  getSourceControlActionAgentSupportText,
  getSourceControlActionAgentWarningText,
  getSourceControlAgentArgsPlaceholder
} from './source-control-action-recipe-options'
import { translate } from '@/i18n/i18n'
import { SourceControlActionOptionField } from './SourceControlActionOptionField'
import { useSourceControlActionAgent } from './use-source-control-action-agent'
import { shouldShowSourceControlActionArguments } from './source-control-action-arguments-visibility'
import { chatProviderAgents, useHostStructuredAgentsVersion } from '@/lib/chat-provider-agents'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'

const DEFAULT_AGENT_VALUE = '__default_agent__'

type SourceControlActionRecipeRowProps<ActionId extends AiActionId> = {
  actionId: ActionId
  selectedAgent: TuiAgent | CustomAgentId | null
  draftValue: ActionRecipeDraftValue
  baseValue: ActionRecipeDraftValue
  defaultTuiAgent: GlobalSettings['defaultTuiAgent']
  isSavingTemplate: boolean
  hasUnsavedChanges?: boolean
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
  selectedAgent,
  draftValue,
  baseValue,
  defaultTuiAgent,
  isSavingTemplate,
  hasUnsavedChanges,
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
  const actual = useSourceControlActionAgent(selectedAgent, defaultTuiAgent)
  const settings = useAppStore((state) => state.settings)
  useHostStructuredAgentsVersion()
  const showArguments = shouldShowSourceControlActionArguments({
    agent: actual.status === 'ready' ? actual.agent : null,
    settings,
    launchKind: surface,
    chatAgents: chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined)
  })
  const expectedAgent = resolveAgentArgsPlaceholderAgent(selectedAgent, defaultTuiAgent)
  const pickerAgent = selectedAgent || actual.status === 'pending' ? expectedAgent : actual.agent
  const isLaunchAction = !AI_TEXT_ACTION_ID_SET.has(actionId)
  const templateDirty =
    hasUnsavedChanges ?? JSON.stringify(draftValue) !== JSON.stringify(baseValue)
  const agentArgsPlaceholder = getSourceControlAgentArgsPlaceholder(
    resolveAgentArgsPlaceholderAgent(selectedAgent, defaultTuiAgent)
  )
  const agentOptions = getAgentCatalogForAction(actionId, selectedAgent)
  const agentWarningText = getSourceControlActionAgentWarningText(actionId, selectedAgent)
  const agentSupportText = getSourceControlActionAgentSupportText(actionId)

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
              agent={selectedAgent && !isCustomAgentId(selectedAgent) ? selectedAgent : null}
              surface={surface}
              onPick={(agent, choice) =>
                onAgentChange(actionId, agent ?? DEFAULT_AGENT_VALUE, choice)
              }
            />
          ) : (
            <Select
              value={selectedAgent ?? DEFAULT_AGENT_VALUE}
              onValueChange={(value) => onAgentChange(actionId, value)}
            >
              <SelectTrigger size="sm" density="compact" className="h-8 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_AGENT_VALUE}>
                  <span className="flex items-center gap-2">
                    <Terminal className="size-3.5 text-muted-foreground" />
                    {translate(
                      'auto.components.settings.SourceControlAiActionRecipeDefaults.ee0e5c2a48',
                      'Use default agent'
                    )}
                  </span>
                </SelectItem>
                {AI_TEXT_ACTION_ID_SET.has(actionId) ? (
                  <SelectItem value={CUSTOM_AGENT_ID}>
                    <span className="flex items-center gap-2">
                      <Terminal className="size-3.5 text-muted-foreground" />
                      {translate(
                        'auto.components.settings.SourceControlAiActionRecipeDefaults.0740d30915',
                        'Custom command'
                      )}
                    </span>
                  </SelectItem>
                ) : null}
                {agentOptions.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    <span className="flex items-center gap-2">
                      <AgentIcon agent={agent.id} size={14} />
                      {agent.label}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {agentWarningText ? (
            <p className="text-[11px] text-destructive">{agentWarningText}</p>
          ) : agentSupportText ? (
            <p className="text-[11px] text-muted-foreground">{agentSupportText}</p>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid min-w-0 grid-cols-1 items-start gap-3">
        {isLaunchAction ? (
          <div className="flex min-w-0 flex-wrap items-start gap-3">
            <SourceControlActionArguments
              showArguments={showArguments}
              agent={pickerAgent}
              value={draftValue.agentArgs}
              preferences={
                pickerAgent
                  ? sourceControlActionSelectedPreferences(
                      { ...draftValue, launchPreferences },
                      pickerAgent
                    )
                  : undefined
              }
              authoredAgent={selectedAgent}
              authoredPreferences={launchPreferences ?? null}
              argumentChoices={draftValue.argumentChoices}
              disabled={actual.status === 'pending' || isSavingTemplate}
              onArgsChange={(value, commit) => onAgentArgsChange(actionId, value, commit)}
              onPreferencesChange={(value, userArgs, nodes) =>
                onLaunchPreferencesChange?.(actionId, value, userArgs, nodes)
              }
            />
          </div>
        ) : (
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
        )}
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
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
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
                onClick={() => onDiscard(actionId)}
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
