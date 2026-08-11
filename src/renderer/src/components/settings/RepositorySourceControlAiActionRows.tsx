import type React from 'react'
import { Terminal } from 'lucide-react'
import type { TuiAgent } from '../../../../shared/types'
import { CUSTOM_AGENT_ID } from '../../../../shared/commit-message-agent-spec'
import type {
  RepoSourceControlAiOverrides,
  SourceControlAiSettings
} from '../../../../shared/source-control-ai-types'
import {
  SOURCE_CONTROL_ACTION_IDS,
  SOURCE_CONTROL_ACTION_LABELS,
  type SourceControlActionId
} from '../../../../shared/source-control-ai-actions'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AgentIcon } from '@/lib/agent-catalog'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import {
  getActionDescriptions,
  SOURCE_CONTROL_TEXT_ACTION_ID_SET,
  getAgentCatalogForAction,
  getSourceControlActionAgentSupportText,
  getSourceControlActionAgentWarningText,
  getSourceControlAgentArgsPlaceholder
} from './source-control-action-recipe-options'
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
import { getRepositorySourceControlAiActionRecipeSectionId } from './repository-settings-targets'
import { translate } from '@/i18n/i18n'

type RepositorySourceControlAiActionRowsProps = {
  repoId: string
  repoAi: RepoSourceControlAiOverrides
  source: SourceControlAiSettings
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
  onActionModeChange: (actionId: SourceControlActionId, mode: string) => void
  onActionAgentChange: (actionId: SourceControlActionId, value: string) => void
  onActionTemplateChange: (actionId: SourceControlActionId, value: string) => void
  onActionAgentArgsChange: (actionId: SourceControlActionId, value: string) => void
  onAppendVariable: (actionId: SourceControlActionId, variable: string) => void
  /** Per-action saving state for CLI args + command template (matches global recipes). */
  savingActionIds: Partial<Record<SourceControlActionId, boolean>>
  actionDirtyById: Record<SourceControlActionId, boolean>
  onActionDiscard: (actionId: SourceControlActionId) => void
  onActionSave: (actionId: SourceControlActionId) => void
}

export function RepositorySourceControlAiActionRows({
  repoId,
  repoAi,
  source,
  defaultTuiAgent,
  onActionModeChange,
  onActionAgentChange,
  onActionTemplateChange,
  onActionAgentArgsChange,
  onAppendVariable,
  savingActionIds,
  actionDirtyById,
  onActionDiscard,
  onActionSave
}: RepositorySourceControlAiActionRowsProps): React.JSX.Element {
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
        const effectiveAgent = hasOverride ? override?.agentId : source.actions?.[actionId]?.agentId
        const agentArgsPlaceholder =
          hasOverride && agentArgsValue
            ? ''
            : inheritedAgentArgs ||
              getSourceControlAgentArgsPlaceholder(
                resolveAgentArgsPlaceholderAgent(effectiveAgent, source, actionId, defaultTuiAgent)
              )
        const agentOptions = getAgentCatalogForAction(actionId, effectiveAgent)
        const agentWarningText = getSourceControlActionAgentWarningText(actionId, effectiveAgent)
        const agentSupportText = getSourceControlActionAgentSupportText(actionId)
        const actionDirty = actionDirtyById[actionId]
        const isSavingAction = savingActionIds[actionId] === true
        return (
          <div
            key={actionId}
            id={getRepositorySourceControlAiActionRecipeSectionId(repoId, actionId)}
            data-settings-section={getRepositorySourceControlAiActionRecipeSectionId(
              repoId,
              actionId
            )}
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
                  <span>
                    {agentArgsStateLabel({
                      hasOverride,
                      inheritedAgentArgs,
                      repoAgentArgs: agentArgsValue
                    })}
                  </span>
                </div>
              </div>
              <Select
                value={hasOverride ? ACTION_MODE_OVERRIDE : ACTION_MODE_INHERIT}
                onValueChange={(value) => onActionModeChange(actionId, value)}
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
            <div className="grid gap-3 sm:grid-cols-[180px_1fr]">
              <div className="space-y-2">
                <Label className="text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.settings.RepositorySourceControlAiActionRows.f4310cf63f',
                    'Agent'
                  )}
                </Label>
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
                    {SOURCE_CONTROL_TEXT_ACTION_ID_SET.has(actionId) ? (
                      <SelectItem value={CUSTOM_AGENT_ID}>
                        <span className="flex items-center gap-2">
                          <Terminal className="size-3.5 text-muted-foreground" />
                          {translate(
                            'auto.components.settings.RepositorySourceControlAiActionRows.2b2f38652b',
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
                {agentWarningText ? (
                  <p className="text-[11px] text-destructive">{agentWarningText}</p>
                ) : agentSupportText ? (
                  <p className="text-[11px] text-muted-foreground">{agentSupportText}</p>
                ) : null}
                <Label className="text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.settings.RepositorySourceControlAiActionRows.7a3a8e431d',
                    'CLI arguments'
                  )}
                </Label>
                <Input
                  value={agentArgsValue}
                  onChange={(event) => onActionAgentArgsChange(actionId, event.target.value)}
                  disabled={!hasOverride}
                  placeholder={agentArgsPlaceholder}
                  spellCheck={false}
                  className="h-8 font-mono text-xs disabled:cursor-not-allowed disabled:bg-muted/40"
                />
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
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-[11px] text-muted-foreground">
                  {actionDirty
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
                  {actionDirty ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => onActionDiscard(actionId)}
                      disabled={isSavingAction}
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
                    onClick={() => onActionSave(actionId)}
                    disabled={!actionDirty || isSavingAction}
                  >
                    {isSavingAction
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
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
