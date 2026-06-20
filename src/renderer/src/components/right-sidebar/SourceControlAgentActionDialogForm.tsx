import React from 'react'
import { CheckCircle2, RefreshCw, RotateCcw, Settings, Sparkles, TriangleAlert } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { SourceControlLaunchActionId } from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import type { GlobalSettings, Repo, TuiAgent } from '../../../../shared/types'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import { sourceControlActionRecipeMatchesTarget } from './source-control-action-recipe-match'
import { translate } from '@/i18n/i18n'

export type SourceControlAgentActionDeliveryPlanState =
  | { status: 'idle' }
  | { status: 'success'; summary: string; commandLabel: string; caveat: string }
  | { status: 'error'; error: string }

type SourceControlAgentActionDialogFormProps = {
  actionId: SourceControlLaunchActionId
  baseCommandInput: string
  agentOptions: AgentCatalogEntry[]
  selectedAgent: TuiAgent | null
  hasEnabledAgents: boolean
  detecting: boolean
  statusCopy: string | null
  agentArgs: string
  commandTemplate: string
  savedCommandInputTemplate?: string | null
  saveLaunchRecipe: boolean
  saveTargetValue: string
  saveTargets: { value: string; label: string }[]
  settings: GlobalSettings | null
  repo: Pick<Repo, 'id' | 'sourceControlAi'> | null
  canSaveAgentDefault: boolean
  deliveryPlan: SourceControlAgentActionDeliveryPlanState
  canStart: boolean
  isStarting: boolean
  startLabel: string
  onSelectedAgentChange: (agent: TuiAgent | null) => void
  onAgentArgsChange: (value: string) => void
  onCommandTemplateChange: (value: string) => void
  onSaveLaunchRecipeChange: (value: boolean) => void
  onSaveAgentDefaultChange: (value: string) => void
  onOpenSettings?: () => void
  onCancel: () => void
  onStart: () => void
}

function sourceControlLaunchSaveTargetFromValue(
  value: string,
  repo: Pick<Repo, 'id'> | null
): SourceControlAiWriteTarget | null {
  if (value === 'repo' && repo?.id) {
    return { type: 'repo', repoId: repo.id }
  }
  if (value === 'global') {
    return { type: 'global' }
  }
  return null
}

export function SourceControlAgentActionDialogForm({
  actionId,
  baseCommandInput,
  agentOptions,
  selectedAgent,
  hasEnabledAgents,
  detecting,
  statusCopy,
  agentArgs,
  commandTemplate,
  savedCommandInputTemplate,
  saveLaunchRecipe,
  saveTargetValue,
  saveTargets,
  settings,
  repo,
  canSaveAgentDefault,
  deliveryPlan,
  canStart,
  isStarting,
  startLabel,
  onSelectedAgentChange,
  onAgentArgsChange,
  onCommandTemplateChange,
  onSaveLaunchRecipeChange,
  onSaveAgentDefaultChange,
  onOpenSettings,
  onCancel,
  onStart
}: SourceControlAgentActionDialogFormProps): React.JSX.Element {
  const defaultCommandTemplate = savedCommandInputTemplate ?? '{basePrompt}'
  const commandTemplateIncludesBasePrompt = commandTemplate.includes('{basePrompt}')
  const selectedRecipe = selectedAgent
    ? {
        agentId: selectedAgent,
        commandInputTemplate: commandTemplate,
        agentArgs
      }
    : null
  const selectedSaveTarget = sourceControlLaunchSaveTargetFromValue(saveTargetValue, repo)
  // Why: start/save only writes the selected target, so the dialog copy must not
  // depend on whether other available targets also match.
  const selectedLaunchRecipeAlreadySaved = Boolean(
    selectedRecipe &&
    selectedSaveTarget &&
    sourceControlActionRecipeMatchesTarget({
      actionId,
      target: selectedSaveTarget,
      recipe: selectedRecipe,
      settings,
      repo
    })
  )
  const showSaveLaunchRecipe = Boolean(canSaveAgentDefault && selectedAgent)
  const saveScopeTargets = saveTargets.filter((target) => target.value !== 'none')
  const effectiveStartLabel =
    showSaveLaunchRecipe && saveLaunchRecipe && !selectedLaunchRecipeAlreadySaved
      ? translate(
          'auto.components.right.sidebar.SourceControlAgentActionDialogForm.5421a96acb',
          'Save & start agent'
        )
      : startLabel

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="min-h-0 min-w-0 max-h-[min(60vh,31rem)] space-y-4 overflow-y-auto pr-1 scrollbar-sleek">
        <div className="space-y-2">
          <Label className="text-xs">
            {translate(
              'auto.components.right.sidebar.SourceControlAgentActionDialogForm.15c5d85706',
              'Agent'
            )}
          </Label>
          {hasEnabledAgents || selectedAgent ? (
            <AgentCombobox
              agents={agentOptions}
              value={selectedAgent}
              onValueChange={onSelectedAgentChange}
              allowNarrowTrigger
              triggerClassName="w-full"
            />
          ) : (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
              <span>
                {detecting
                  ? translate(
                      'auto.components.right.sidebar.SourceControlAgentActionDialogForm.c7ff8cef11',
                      'Detecting agents...'
                    )
                  : translate(
                      'auto.components.right.sidebar.SourceControlAgentActionDialogForm.1d47db9bf0',
                      'No enabled agents'
                    )}
              </span>
              {onOpenSettings ? (
                <Button type="button" variant="ghost" size="xs" onClick={onOpenSettings}>
                  <Settings className="size-3.5" />
                  {translate(
                    'auto.components.right.sidebar.SourceControlAgentActionDialogForm.b99c33cec5',
                    'Settings'
                  )}
                </Button>
              ) : null}
            </div>
          )}
          {statusCopy ? (
            <p className="flex items-start gap-1.5 text-[11px] text-destructive">
              <TriangleAlert className="mt-px size-3 shrink-0" />
              <span>{statusCopy}</span>
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="source-control-agent-cli-args" className="text-xs">
            {translate(
              'auto.components.right.sidebar.SourceControlAgentActionDialogForm.bc8dc39f4b',
              'CLI arguments'
            )}
          </Label>
          <Input
            id="source-control-agent-cli-args"
            value={agentArgs}
            spellCheck={false}
            placeholder={translate(
              'auto.components.right.sidebar.SourceControlAgentActionDialogForm.fe119187bb',
              '--model sonnet'
            )}
            onChange={(event) => onAgentArgsChange(event.target.value)}
            className="h-8 font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <Label htmlFor="source-control-agent-command-input" className="text-xs">
                {translate(
                  'auto.components.right.sidebar.SourceControlAgentActionDialogForm.f4f3c9ca4a',
                  'Prompt template'
                )}
              </Label>
              <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
                {translate(
                  'auto.components.right.sidebar.SourceControlAgentActionDialogForm.5c75b24735',
                  'Customize what the agent receives before Orca starts it.'
                )}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={commandTemplate === defaultCommandTemplate}
              onClick={() => onCommandTemplateChange(defaultCommandTemplate)}
            >
              <RotateCcw className="size-3.5" />
              {translate(
                'auto.components.right.sidebar.SourceControlAgentActionDialogForm.7ec6abbf2a',
                'Reset'
              )}
            </Button>
          </div>
          <textarea
            id="source-control-agent-command-input"
            rows={7}
            value={commandTemplate}
            onChange={(event) => onCommandTemplateChange(event.target.value)}
            className="box-border min-h-[6.5rem] min-w-0 w-full max-w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
            spellCheck={false}
          />
          <SourceControlActionVariableChips
            actionId={actionId}
            variablePreviews={{ basePrompt: baseCommandInput }}
            onInsert={(variable) => {
              const separator =
                commandTemplate.endsWith('\n') || commandTemplate.length === 0 ? '' : ' '
              onCommandTemplateChange(`${commandTemplate}${separator}{${variable}}`)
            }}
          />
          {!commandTemplateIncludesBasePrompt ? (
            <p className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-[11px] leading-4 text-destructive">
              <TriangleAlert className="mt-px size-3 shrink-0" />
              <span>
                {translate(
                  'auto.components.right.sidebar.SourceControlAgentActionDialogForm.23280cbab1',
                  "This template does not include {basePrompt}, so the agent will not receive Orca's default prompt."
                )}
              </span>
            </p>
          ) : null}
        </div>

        {showSaveLaunchRecipe ? (
          <div
            className={cn(
              'space-y-2 rounded-md border border-border bg-background p-3',
              saveLaunchRecipe && 'border-foreground shadow-[inset_0_0_0_1px_var(--foreground)]'
            )}
          >
            <label className="grid cursor-pointer grid-cols-[1rem_1fr] items-start gap-2.5">
              <input
                type="checkbox"
                checked={saveLaunchRecipe}
                onChange={(event) => onSaveLaunchRecipeChange(event.target.checked)}
                className="mt-0.5 size-3.5 accent-foreground"
              />
              <span>
                <span className="block text-xs font-semibold">
                  {selectedLaunchRecipeAlreadySaved
                    ? translate(
                        'auto.components.right.sidebar.SourceControlAgentActionDialogForm.b0da3a4d3e',
                        'Launch recipe already saved'
                      )
                    : translate(
                        'auto.components.right.sidebar.SourceControlAgentActionDialogForm.c29f9cf266',
                        "Save this prompt and don't show this review next time"
                      )}
                </span>
                <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
                  {selectedLaunchRecipeAlreadySaved
                    ? translate(
                        'auto.components.right.sidebar.SourceControlAgentActionDialogForm.bff4795a6d',
                        'Change the agent, arguments, or prompt template to update the saved recipe.'
                      )
                    : translate(
                        'auto.components.right.sidebar.SourceControlAgentActionDialogForm.6cefcdfba1',
                        'You can change it later in Source Control AI settings.'
                      )}
                </span>
              </span>
            </label>
            {saveLaunchRecipe ? (
              <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2 border-t border-border pt-2">
                <span className="text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.right.sidebar.SourceControlAgentActionDialogForm.013c9ac04a',
                    'Save for'
                  )}
                </span>
                <Select value={saveTargetValue} onValueChange={onSaveAgentDefaultChange}>
                  <SelectTrigger size="sm" className="h-8 w-full text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {saveScopeTargets.map((target) => (
                      <SelectItem key={target.value} value={target.value}>
                        {target.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
        ) : null}

        {deliveryPlan.status !== 'idle' ? (
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-xs',
              deliveryPlan.status === 'error'
                ? 'border-destructive/30 bg-destructive/5 text-destructive'
                : 'border-border bg-muted/30 text-muted-foreground'
            )}
          >
            {deliveryPlan.status === 'error' ? (
              <span className="inline-flex items-start gap-2">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {deliveryPlan.error}
              </span>
            ) : (
              <div className="space-y-1.5">
                <div className="flex items-start gap-2 text-foreground">
                  <CheckCircle2 className="mt-px size-3.5 shrink-0 text-status-success" />
                  <span>{deliveryPlan.summary}</span>
                </div>
                <div className="truncate font-mono text-[11px]">
                  {translate(
                    'auto.components.right.sidebar.SourceControlAgentActionDialogForm.1bc0bdbb5e',
                    'Launch:'
                  )}
                  {deliveryPlan.commandLabel}
                </div>
                <div className="text-[11px]">{deliveryPlan.caveat}</div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <DialogFooter className="flex-wrap gap-2 sm:justify-end">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
          {translate(
            'auto.components.right.sidebar.SourceControlAgentActionDialogForm.ea4788705e',
            'Cancel'
          )}
        </Button>
        <Button type="button" size="sm" disabled={!canStart} onClick={onStart}>
          {isStarting ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {effectiveStartLabel}
        </Button>
      </DialogFooter>
    </div>
  )
}
