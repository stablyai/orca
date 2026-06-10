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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { AgentIcon } from '@/lib/agent-catalog'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import {
  getActionDescriptions,
  SOURCE_CONTROL_TEXT_ACTION_ID_SET,
  getAgentCatalogForAction,
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
import { translate } from '@/i18n/i18n'

type RepositorySourceControlAiActionRowsProps = {
  repoAi: RepoSourceControlAiOverrides
  source: SourceControlAiSettings
  defaultTuiAgent: TuiAgent | 'blank' | null | undefined
  onActionModeChange: (actionId: SourceControlActionId, mode: string) => void
  onActionAgentChange: (actionId: SourceControlActionId, value: string) => void
  onActionTemplateChange: (actionId: SourceControlActionId, value: string) => void
  onActionAgentArgsChange: (actionId: SourceControlActionId, value: string) => void
  onAppendVariable: (actionId: SourceControlActionId, variable: string) => void
}

export function RepositorySourceControlAiActionRows({
  repoAi,
  source,
  defaultTuiAgent,
  onActionModeChange,
  onActionAgentChange,
  onActionTemplateChange,
  onActionAgentArgsChange,
  onAppendVariable
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
        return (
          <div key={actionId} className="space-y-3 rounded-md border border-border px-3 py-3">
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
          </div>
        )
      })}
    </div>
  )
}
