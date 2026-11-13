import { useAppStore } from '@/store/index'
import React, { useCallback, useMemo, useState } from 'react'
import { RefreshCw, Save, Sparkles, Terminal, TriangleAlert } from 'lucide-react'
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
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { commitMessagePickerModel } from '@/components/feature-wall/commit-pr-settings/ai-commit-pr-picker'
import type { AgentPickerEntry } from '../../../../../../shared/agent-launch/picker/agent-launch-picker'
import { planSourceControlTextGeneration } from '@/lib/source-control/ai/source-control-generation-plan'
import {
  CUSTOM_AGENT_ID,
  isCustomAgentId,
  listCommitMessageAgentCapabilities
} from '../../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { formatLinkedIssueTemplateValue } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-action-variables'
import type { SourceControlTextActionId } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../../../shared/source-control/ai/settings/source-control-ai-recipe-save'
import type { SourceControlRenderSettings } from '../listing/use-worktree-context'
import type { Repo } from '../../../../../../shared/repo-types'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import { toast } from 'sonner'
import { SourceControlActionVariableChips } from '../../../source-control/SourceControlActionVariableChips'
import { sourceControlTextGenerationDefaultsMatchTarget } from './text-generation-defaults'
import {
  buildCommitMessageGenerationParams,
  type CommitMessageGenerationAgentChoice
} from './text-generation-params'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'

export type SourceControlTextGenerationSaveTarget = {
  target: SourceControlAiWriteTarget
  label: string
  successMessage: string
}

type SourceControlTextGenerationDialogFormProps = {
  actionId: SourceControlTextActionId
  generateLabel: string
  settings: SourceControlRenderSettings | null
  repo: Pick<Repo, 'id' | 'sourceControlAi'> | null
  baseParams: ResolvedSourceControlAiGenerationParams | null
  basePromptPreview?: string
  /** Omitted by workspace-less callers (Settings dry-run); `null` means "linked to nothing". */
  linkedIssue?: number | null
  saveTargets: SourceControlTextGenerationSaveTarget[]
  onGenerate: (params: ResolvedSourceControlAiGenerationParams) => void
  onOpenChange: (open: boolean) => void
  onSaveDefaults: (
    target: SourceControlAiWriteTarget,
    params: ResolvedSourceControlAiGenerationParams
  ) => Promise<void> | void
}

export function sourceControlTextGenerationSaveTargetKey(
  target: SourceControlAiWriteTarget
): string {
  return target.type === 'repo' ? `repo:${target.repoId}` : 'global'
}

export function getDefaultSourceControlTextGenerationSaveTargetKey(
  saveTargets: SourceControlTextGenerationSaveTarget[]
): string {
  const defaultTarget =
    saveTargets.find((saveTarget) => saveTarget.target.type === 'global') ?? saveTargets[0]
  return defaultTarget ? sourceControlTextGenerationSaveTargetKey(defaultTarget.target) : 'global'
}

function agentLabel(agentId: TuiAgent): string {
  return getAgentCatalog().find((agent) => agent.id === agentId)?.label ?? agentId
}

export function SourceControlTextGenerationDialogForm({
  actionId,
  generateLabel,
  settings,
  repo,
  baseParams,
  basePromptPreview,
  linkedIssue,
  saveTargets,
  onGenerate,
  onOpenChange,
  onSaveDefaults
}: SourceControlTextGenerationDialogFormProps): React.JSX.Element {
  const t = useTranslate()
  const entries = useMemo<AgentPickerEntry[]>(
    () =>
      listCommitMessageAgentCapabilities().map((capability) => ({
        agent: capability.id,
        label: agentLabel(capability.id),
        rows: [{ agent: capability.id, kind: 'cli' }],
        surfaces: ['terminal'],
        defaultSurface: 'terminal',
        terminal: {},
        structured: {},
        catalog: { origin: 'unknown' },
        arguments: ''
      })),
    []
  )
  const pickerModel = useMemo(() => commitMessagePickerModel(entries), [entries])
  const showCustomAgent = Boolean(
    baseParams && (isCustomAgentId(baseParams.agentId) || baseParams.customAgentCommand?.trim())
  )
  const [agentId, setAgentId] = useState<CommitMessageGenerationAgentChoice>(
    baseParams?.agentId ?? ''
  )
  const [commandTemplate, setCommandTemplate] = useState(
    baseParams?.commandInputTemplate ?? '{basePrompt}'
  )
  const [agentArgs, setAgentArgs] = useState(baseParams?.agentArgs ?? '')
  const [generationError, setGenerationError] = useState<string | null>(null)
  const [savingTargetKey, setSavingTargetKey] = useState<string | null>(null)
  const defaultSaveTargetKey = getDefaultSourceControlTextGenerationSaveTargetKey(saveTargets)
  const [saveTargetKey, setSaveTargetKey] = useState(defaultSaveTargetKey)
  const commandTemplateId = `source-control-${actionId}-command-template`
  const selectedSaveTarget =
    saveTargets.find((saveTarget) => {
      return sourceControlTextGenerationSaveTargetKey(saveTarget.target) === saveTargetKey
    }) ?? saveTargets[0]

  const buildParams = (settings: SourceControlRenderSettings | null) =>
    buildCommitMessageGenerationParams({
      agentId,
      commandTemplate,
      agentArgs,
      baseParams,
      settings,
      customAgentCommand: baseParams?.customAgentCommand
    })
  const params = buildParams(settings)
  // Only chips use workspace previews; synthetic planning keeps empty linkedIssue from blocking repo/global recipe saves.
  const variablePreviews = useMemo(() => {
    const previews: Record<string, string> = {}
    if (basePromptPreview) {
      previews.basePrompt = basePromptPreview
    }
    if (linkedIssue !== undefined) {
      previews.linkedIssue = formatLinkedIssueTemplateValue(linkedIssue)
    }
    return Object.keys(previews).length > 0 ? previews : undefined
  }, [basePromptPreview, linkedIssue])
  const paramsPlanResult = params ? planSourceControlTextGeneration(actionId, params, t) : null
  const canRunGeneration = Boolean(params && paramsPlanResult?.ok)
  const saving = savingTargetKey !== null
  const defaultsAlreadySaved = Boolean(
    params &&
    selectedSaveTarget &&
    sourceControlTextGenerationDefaultsMatchTarget({
      actionId,
      target: selectedSaveTarget.target,
      params,
      settings,
      repo
    })
  )
  const allSaveTargetsAlreadySaved = Boolean(
    params &&
    saveTargets.length > 0 &&
    saveTargets.every((saveTarget) =>
      sourceControlTextGenerationDefaultsMatchTarget({
        actionId,
        target: saveTarget.target,
        params,
        settings,
        repo
      })
    )
  )
  const showSaveRecipeControl = Boolean(selectedSaveTarget && !allSaveTargetsAlreadySaved)

  const saveCurrentDefaults = useCallback(
    async (
      saveTarget: SourceControlTextGenerationSaveTarget,
      options: { showToast: boolean; showErrors: boolean }
    ): Promise<boolean> => {
      if (!params || saving || !paramsPlanResult?.ok) {
        if (options.showErrors) {
          setGenerationError(
            paramsPlanResult && !paramsPlanResult.ok
              ? paramsPlanResult.error
              : 'Choose an agent before saving defaults.'
          )
        }
        return false
      }
      const targetKey = sourceControlTextGenerationSaveTargetKey(saveTarget.target)
      setSavingTargetKey(targetKey)
      try {
        await onSaveDefaults(saveTarget.target, params)
        if (options.showToast) {
          toast.success(saveTarget.successMessage)
        }
        return true
      } catch (error) {
        console.error('Failed to save Source Control AI defaults', error)
        if (options.showErrors) {
          setGenerationError(
            translate(
              'sourceControl.actionSaveFailed',
              'Could not save this action. Try saving it again in Settings.'
            )
          )
        }
        return false
      } finally {
        setSavingTargetKey(null)
      }
    },
    [onSaveDefaults, params, paramsPlanResult, saving]
  )

  const handleGenerate = (): void => {
    if (!params || !paramsPlanResult?.ok) {
      setGenerationError(
        paramsPlanResult && !paramsPlanResult.ok
          ? paramsPlanResult.error
          : 'Choose an agent before generating.'
      )
      return
    }
    onGenerate(buildParams(useAppStore.getState().settings) ?? params)
    onOpenChange(false)
  }

  const handleSaveDefaults = async (
    saveTarget: SourceControlTextGenerationSaveTarget
  ): Promise<void> => {
    await saveCurrentDefaults(saveTarget, { showToast: true, showErrors: true })
  }

  return (
    <>
      <div className="min-w-0 space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">
            {t(
              'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.9c14186dd2',
              'Agent'
            )}
          </Label>
          <AgentLaunchPicker
            model={pickerModel}
            entries={entries}
            setupDisabled
            agent={agentId && !isCustomAgentId(agentId) ? agentId : null}
            triggerLabel={
              isCustomAgentId(agentId)
                ? t(
                    'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.914c8f6ac2',
                    'Custom command'
                  )
                : undefined
            }
            emptyLabel={t(
              'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.cce2cbd01d',
              'Choose agent'
            )}
            onPick={(agent) => {
              setAgentId(agent)
              setGenerationError(null)
            }}
          >
            {showCustomAgent ? (
              <DropdownMenuItem
                onSelect={() => {
                  setAgentId(CUSTOM_AGENT_ID)
                  setGenerationError(null)
                }}
              >
                <Terminal className="size-3.5 text-muted-foreground" />
                {t(
                  'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.914c8f6ac2',
                  'Custom command'
                )}
              </DropdownMenuItem>
            ) : null}
          </AgentLaunchPicker>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`source-control-${actionId}-cli-args`} className="text-xs">
            {t(
              'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.4eab815004',
              'CLI arguments'
            )}
          </Label>
          <Input
            id={`source-control-${actionId}-cli-args`}
            value={agentArgs}
            spellCheck={false}
            placeholder={t(
              'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.551ffd111b',
              '--model sonnet'
            )}
            onChange={(event) => {
              setAgentArgs(event.target.value)
              setGenerationError(null)
            }}
            className="h-8 font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={commandTemplateId} className="text-xs">
            {t(
              'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.1f6fcfb6cf',
              'Command template'
            )}
          </Label>
          <textarea
            id={commandTemplateId}
            rows={8}
            value={commandTemplate}
            spellCheck={false}
            onChange={(event) => {
              setCommandTemplate(event.target.value)
              setGenerationError(null)
            }}
            className="box-border min-w-0 w-full max-w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
          />
          <SourceControlActionVariableChips
            actionId={actionId}
            variablePreviews={variablePreviews}
            onInsert={(variable) => {
              const separator =
                commandTemplate.endsWith('\n') || commandTemplate.length === 0 ? '' : ' '
              setCommandTemplate(`${commandTemplate}${separator}{${variable}}`)
              setGenerationError(null)
            }}
          />
        </div>

        {showSaveRecipeControl ? (
          <div className="space-y-2">
            <Label className="text-xs">
              {t(
                'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.d91b0a189d',
                'Save recipe'
              )}
            </Label>
            <Select value={saveTargetKey} onValueChange={setSaveTargetKey}>
              <SelectTrigger size="sm" className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {saveTargets.map((saveTarget) => {
                  const targetKey = sourceControlTextGenerationSaveTargetKey(saveTarget.target)
                  return (
                    <SelectItem key={targetKey} value={targetKey}>
                      {saveTarget.label}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        {generationError ? (
          <p className="flex items-start gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            {generationError}
          </p>
        ) : null}
      </div>

      <DialogFooter className="flex-wrap gap-2 sm:justify-end">
        {selectedSaveTarget && !defaultsAlreadySaved ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canRunGeneration || saving}
            onClick={() => void handleSaveDefaults(selectedSaveTarget)}
          >
            {savingTargetKey === saveTargetKey ? (
              <RefreshCw className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            {t(
              'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.25fcd8e49a',
              'Save defaults'
            )}
          </Button>
        ) : null}
        <Button
          type="button"
          size="sm"
          disabled={!canRunGeneration || saving}
          onClick={handleGenerate}
        >
          <Sparkles className="size-4" />
          {generateLabel}
        </Button>
      </DialogFooter>
    </>
  )
}
