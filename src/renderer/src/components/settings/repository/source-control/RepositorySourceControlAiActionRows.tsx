import type { SourceControlActionId } from '../../../../../../shared/source-control-ai-actions'
import { useRepositoryActionPickerInputs } from './use-repository-action-picker-inputs'
import { shallow } from 'zustand/shallow'
import { sameAgentLaunchPickerModel } from '../../../tab-bar/new-tab-agent-menu-model'
import { selectSourceControlActionRecipe } from '../../../../../../shared/source-control-action-selection'
import type { RepositorySourceControlAiActionRowsProps } from './repository-source-control-ai-action-rows-props'
import { sourceControlActionExecutionArgs } from '../../../../../../shared/source-control-action-launch-preferences'
import type { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import {
  SourceControlActionAgentPickerView,
  sourceControlActionAgentPreview
} from '../../SourceControlActionAgentPicker'
import { memo, useMemo, type JSX } from 'react'
import { invalidateAgentPickerDrafts } from '../../../agent/AgentLaunchSetupButton'
import { Terminal } from 'lucide-react'

import {
  CUSTOM_AGENT_ID,
  isCustomAgentId
} from '../../../../../../shared/commit-message-agent-spec'

import {
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_ACTION_LABELS
} from '../../../../../../shared/source-control-ai-actions'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { RepositorySourceControlAiActionSaveControls } from '../../RepositorySourceControlAiActionSaveControls'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { AgentIcon } from '@/lib/agent-catalog'
import { SourceControlActionVariableChips } from '../../../source-control/SourceControlActionVariableChips'
import {
  getActionDescriptions,
  SOURCE_CONTROL_TEXT_ACTION_ID_SET,
  getAgentCatalogForAction,
  getSourceControlActionAgentSupportText,
  getSourceControlActionAgentWarningText,
  getSourceControlAgentArgsPlaceholder
} from '../../source-control-action-recipe-options'
import {
  ACTION_MODE_INHERIT,
  ACTION_MODE_OVERRIDE,
  DEFAULT_AGENT_VALUE,
  actionAgentSelectValue,
  actionScopeLabel,
  agentArgsStateLabel,
  commandTemplateStateLabel,
  readInheritedAgentArgs,
  readInheritedCommandTemplate,
  resolveAgentArgsPlaceholderAgent
} from './repository-source-control-ai-labels'
import { hasOwnActionOverride } from './repository-source-control-ai-draft'
import { getRepositorySourceControlAiActionRecipeSectionId } from '../repository-settings-targets'
import { translate } from '@/i18n/i18n'
import { SourceControlActionOptionField } from '../../SourceControlActionOptionField'
import type { useSourceControlActionAgent } from '../../use-source-control-action-agent'
import { captureSourceControlActionSelection } from '../../../../../../shared/source-control-ai-operation-policy'

export function RepositorySourceControlAiActionRows(
  props: RepositorySourceControlAiActionRowsProps
): JSX.Element {
  const inputs = useRepositoryActionPickerInputs(props)
  return <SelectedRepositoryActionRows {...props} {...inputs} />
}

const SelectedRepositoryActionRows = memo(
  function SelectedRepositoryActionRows({
    repoId,
    repoAi,
    source,
    defaultTuiAgent,
    onActionModeChange,
    onActionAgentChange,
    onActionLaunchPreferencesChange,
    onActionTemplateChange,
    onActionAgentArgsChange,
    onAppendVariable,
    savingActionIds,
    actionDirtyById,
    onActionDiscard,
    onActionSave,
    draftScopes,
    observation,
    canSaveSurface,
    resolveAgent
  }: RepositorySourceControlAiActionRowsProps & {
    draftScopes: Map<SourceControlActionId, object>
    observation: ReturnType<typeof useAgentMenuObservation>
    canSaveSurface: boolean
    resolveAgent: ReturnType<typeof useSourceControlActionAgent>['resolve']
  }): JSX.Element {
    const selections = useMemo(
      () =>
        new Map(
          SOURCE_CONTROL_ACTION_IDS.map((actionId) => [
            actionId,
            captureSourceControlActionSelection({
              settings: { sourceControlAi: source },
              repo: { sourceControlAi: repoAi },
              actionId
            })
          ])
        ),
      [source, repoAi]
    )
    const recipes = useMemo(
      () =>
        new Map(
          [...selections].map(([id, selection]) => [id, selectSourceControlActionRecipe(selection)])
        ),
      [selections]
    )
    return (
      <div className="space-y-3">
        <Label className="text-xs font-medium">
          {translate(
            'auto.components.settings.RepositorySourceControlAiActionRows.f0aa2cfaea',
            'Action recipes'
          )}
        </Label>
        {SOURCE_CONTROL_ACTION_IDS.map((actionId) => {
          const hasOverride = hasOwnActionOverride(repoAi.actionOverrides, actionId)
          const override = repoAi.actionOverrides?.[actionId]
          const inheritedTemplate = readInheritedCommandTemplate(source, actionId)
          const inheritedAgentArgs = readInheritedAgentArgs(source, actionId)
          const templateValue =
            hasOverride && typeof override?.commandInputTemplate === 'string'
              ? override.commandInputTemplate
              : ''
          const agentArgsValue =
            hasOverride && typeof override?.agentArgs === 'string' ? override.agentArgs : ''
          const recipe = recipes.get(actionId)!
          const effectiveAgent = recipe.agentId
          const selectedAgent =
            effectiveAgent && !isCustomAgentId(effectiveAgent) ? effectiveAgent : null
          const isLaunchAction = !SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId)
          const actual = isLaunchAction
            ? sourceControlActionAgentPreview(observation, selectedAgent)
            : resolveAgent(effectiveAgent)
          const pickerAgent =
            effectiveAgent || actual.status === 'pending'
              ? resolveAgentArgsPlaceholderAgent(
                  effectiveAgent,
                  source,
                  actionId,
                  isLaunchAction ? observation.preferences.defaultTuiAgent : defaultTuiAgent
                )
              : actual.agent
          const agentArgsPlaceholder =
            hasOverride && agentArgsValue
              ? ''
              : (pickerAgent
                  ? sourceControlActionExecutionArgs(recipe, pickerAgent)
                  : inheritedAgentArgs) ||
                (isLaunchAction
                  ? ''
                  : getSourceControlAgentArgsPlaceholder(
                      resolveAgentArgsPlaceholderAgent(
                        effectiveAgent,
                        source,
                        actionId,
                        defaultTuiAgent
                      )
                    ))
          const agentOptions = getAgentCatalogForAction(actionId, effectiveAgent)
          const agentWarningText = getSourceControlActionAgentWarningText(actionId, effectiveAgent)
          const agentSupportText = getSourceControlActionAgentSupportText(actionId)
          const actionDirty = actionDirtyById[actionId]
          const isSavingAction = savingActionIds[actionId] === true
          const sectionId = getRepositorySourceControlAiActionRecipeSectionId(repoId, actionId)
          return (
            <div
              key={actionId}
              id={sectionId}
              data-settings-section={sectionId}
              className="scroll-mt-8 space-y-3 rounded-md border border-border px-3 py-3"
            >
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <p className="text-xs font-medium text-foreground">
                    {SOURCE_CONTROL_ACTION_LABELS[actionId]}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {getActionDescriptions()[actionId]}
                  </p>
                  <div className="flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                    <span>{actionScopeLabel(hasOverride)}</span>
                    <span>
                      {commandTemplateStateLabel({ hasOverride, inheritedTemplate, actionId })}
                    </span>
                    <span>{agentArgsStateLabel({ recipe, agent: pickerAgent, override })}</span>
                  </div>
                </div>
                <Select
                  value={hasOverride ? ACTION_MODE_OVERRIDE : ACTION_MODE_INHERIT}
                  onValueChange={(value) => {
                    const scope = draftScopes.get(actionId)
                    if (scope) {
                      invalidateAgentPickerDrafts(scope)
                    }
                    onActionModeChange(actionId, value)
                  }}
                >
                  <SelectTrigger size="sm" className="h-8 w-full shrink-0 text-xs sm:w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ACTION_MODE_INHERIT}>
                      {translate(
                        'auto.components.settings.RepositorySourceControlAiActionRows.403876bb48',
                        'Use global'
                      )}
                    </SelectItem>
                    <SelectItem value={ACTION_MODE_OVERRIDE}>
                      {translate(
                        'auto.components.settings.RepositorySourceControlAiActionRows.1cd88d470a',
                        'Customize'
                      )}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid min-w-0 grid-cols-1 items-start gap-3">
                <div className="space-y-2">
                  <Label className="text-[11px] text-muted-foreground">
                    {translate(
                      'auto.components.settings.RepositorySourceControlAiActionRows.f4310cf63f',
                      'Agent'
                    )}
                  </Label>
                  {isLaunchAction ? (
                    <SourceControlActionAgentPickerView
                      draftScope={draftScopes.get(actionId)}
                      agent={selectedAgent}
                      surface={recipe.surface}
                      observation={observation}
                      canSaveSurface={canSaveSurface}
                      disabled={!hasOverride || isSavingAction}
                      selection={selections.get(actionId)}
                      onSetupPick={(selection, previous, argumentsAuthored) =>
                        onActionLaunchPreferencesChange(
                          actionId,
                          selection.source.authoredPreferences,
                          argumentsAuthored ||
                            selection.current.agentArgs !== previous.current.agentArgs
                            ? selection.current.agentArgs
                            : undefined,
                          selection.current.argumentChoices !== previous.current.argumentChoices
                            ? (selection.current.argumentChoices ?? null)
                            : undefined
                        )
                      }
                      onPick={(agent, choice) =>
                        onActionAgentChange(actionId, agent ?? DEFAULT_AGENT_VALUE, choice)
                      }
                    />
                  ) : (
                    <Select
                      value={actionAgentSelectValue(effectiveAgent)}
                      onValueChange={(value) => onActionAgentChange(actionId, value)}
                      disabled={!hasOverride}
                    >
                      <SelectTrigger size="sm" className="h-8 w-full text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={DEFAULT_AGENT_VALUE}>
                          <span className="flex items-center gap-2">
                            <Terminal className="size-3.5 text-muted-foreground" />
                            {translate(
                              'auto.components.settings.RepositorySourceControlAiActionRows.0ffb081b3a',
                              'Use default agent'
                            )}
                          </span>
                        </SelectItem>
                        <SelectItem value={CUSTOM_AGENT_ID}>
                          <span className="flex items-center gap-2">
                            <Terminal className="size-3.5 text-muted-foreground" />
                            {translate(
                              'auto.components.settings.RepositorySourceControlAiActionRows.2b2f38652b',
                              'Custom command'
                            )}
                          </span>
                        </SelectItem>
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
                <div className="flex min-w-0 flex-wrap items-start gap-3">
                  {!isLaunchAction ? (
                    <SourceControlActionOptionField
                      label={translate(
                        'auto.components.settings.AgentsPane.cfb3f35775',
                        'Arguments'
                      )}
                    >
                      <Input
                        value={agentArgsValue}
                        onChange={(event) => onActionAgentArgsChange(actionId, event.target.value)}
                        disabled={!hasOverride}
                        placeholder={agentArgsPlaceholder}
                        spellCheck={false}
                        className="h-8 font-mono text-xs disabled:cursor-not-allowed disabled:bg-muted/40"
                      />
                    </SourceControlActionOptionField>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label className="text-[11px] text-muted-foreground">
                    {translate(
                      'auto.components.settings.RepositorySourceControlAiActionRows.548a6e1281',
                      'Command template'
                    )}
                  </Label>
                  <textarea
                    rows={3}
                    value={templateValue}
                    onChange={(event) => onActionTemplateChange(actionId, event.target.value)}
                    disabled={!hasOverride}
                    placeholder={inheritedTemplate}
                    spellCheck={false}
                    className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:bg-muted/40"
                  />
                  <SourceControlActionVariableChips
                    actionId={actionId}
                    disabled={!hasOverride}
                    onInsert={(variable) => onAppendVariable(actionId, variable)}
                  />
                </div>
              </div>
              {hasOverride ? (
                <RepositorySourceControlAiActionSaveControls
                  actionDirty={actionDirty}
                  isSavingAction={isSavingAction}
                  onDiscard={() => {
                    const scope = draftScopes.get(actionId)
                    if (scope) {
                      invalidateAgentPickerDrafts(scope)
                    }
                    onActionDiscard(actionId)
                  }}
                  onSave={() => onActionSave(actionId)}
                />
              ) : null}
            </div>
          )
        })}
      </div>
    )
  },
  (a, b) => {
    const { observation: x, ...before } = a
    const { observation: y, ...after } = b
    return (
      shallow(before, after) &&
      x.preferencesPending === y.preferencesPending &&
      x.preferences.defaultTuiAgent === y.preferences.defaultTuiAgent &&
      x.preferences.disabledTuiAgents === y.preferences.disabledTuiAgents &&
      sameAgentLaunchPickerModel(x.model, y.model)
    )
  }
)
