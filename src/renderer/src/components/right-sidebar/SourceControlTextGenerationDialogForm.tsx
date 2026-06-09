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
import { getAgentCatalog, AgentIcon } from '@/lib/agent-catalog'
import { planSourceControlTextGeneration } from '@/lib/source-control-generation-plan'
import {
  CUSTOM_AGENT_ID,
  isCustomAgentId,
  listCommitMessageAgentCapabilities
} from '../../../../shared/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../shared/source-control-ai'
import type { SourceControlTextActionId } from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import type { GlobalSettings, Repo, TuiAgent } from '../../../../shared/types'
import { toast } from 'sonner'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import { sourceControlTextGenerationDefaultsMatchTarget } from './source-control-text-generation-defaults'
import {
  buildCommitMessageGenerationParams,
  type CommitMessageGenerationAgentChoice
} from './SourceControlTextGenerationParams'
import { translate } from '@/i18n/i18n'

const UNCONFIGURED_AGENT_SELECT_VALUE = ''

export type SourceControlTextGenerationSaveTarget = {
  target: SourceControlAiWriteTarget
  label: string
  successMessage: string
}

type SourceControlTextGenerationDialogFormProps = {
  actionId: SourceControlTextActionId
  generateLabel: string
  settings: GlobalSettings | null
  repo: Pick<Repo, 'id' | 'sourceControlAi'> | null
  baseParams: ResolvedSourceControlAiGenerationParams | null
  saveTargets: SourceControlTextGenerationSaveTarget[]
  onGenerate: (params: ResolvedSourceControlAiGenerationParams) => void
  onOpenChange: (open: boolean) => void
  onSaveDefaults: (
    target: SourceControlAiWriteTarget,
    params: ResolvedSourceControlAiGenerationParams
  ) => Promise<void> | void
}

function sourceControlTextGenerationSaveTargetKey(target: SourceControlAiWriteTarget): string {
  return target.type === 'repo' ? `repo:${target.repoId}` : 'global'
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
  saveTargets,
  onGenerate,
  onOpenChange,
  onSaveDefaults
}: SourceControlTextGenerationDialogFormProps): React.JSX.Element {
  const capabilities = useMemo(() => listCommitMessageAgentCapabilities(), [])
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
  const defaultSaveTargetKey = saveTargets[0]
    ? sourceControlTextGenerationSaveTargetKey(saveTargets[0].target)
    : 'global'
  const [saveTargetKey, setSaveTargetKey] = useState(defaultSaveTargetKey)
  const commandTemplateId = `source-control-${actionId}-command-template`
  const selectedSaveTarget =
    saveTargets.find((saveTarget) => {
      return sourceControlTextGenerationSaveTargetKey(saveTarget.target) === saveTargetKey
    }) ?? saveTargets[0]

  const params = buildCommitMessageGenerationParams({
    agentId,
    commandTemplate,
    agentArgs,
    baseParams,
    settings,
    customAgentCommand: baseParams?.customAgentCommand
  })
  const paramsPlanResult = params ? planSourceControlTextGeneration(actionId, params) : null
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
    onGenerate(params)
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
            {translate(
              'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.9c14186dd2',
              'Agent'
            )}
          </Label>
          <Select
            value={agentId || UNCONFIGURED_AGENT_SELECT_VALUE}
            onValueChange={(value) => {
              if (value === UNCONFIGURED_AGENT_SELECT_VALUE) {
                return
              }
              setAgentId(value === CUSTOM_AGENT_ID ? CUSTOM_AGENT_ID : (value as TuiAgent))
              setGenerationError(null)
            }}
          >
            <SelectTrigger size="sm" className="h-8 text-xs">
              <SelectValue
                placeholder={translate(
                  'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.cce2cbd01d',
                  'Choose agent'
                )}
              />
            </SelectTrigger>
            <SelectContent>
              {capabilities.map((capability) => (
                <SelectItem key={capability.id} value={capability.id}>
                  <span className="flex items-center gap-2">
                    <AgentIcon agent={capability.id} size={14} />
                    {agentLabel(capability.id)}
                  </span>
                </SelectItem>
              ))}
              {showCustomAgent ? (
                <SelectItem value={CUSTOM_AGENT_ID}>
                  <span className="flex items-center gap-2">
                    <Terminal className="size-3.5 text-muted-foreground" />
                    {translate(
                      'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.914c8f6ac2',
                      'Custom command'
                    )}
                  </span>
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`source-control-${actionId}-cli-args`} className="text-xs">
            {translate(
              'auto.components.right.sidebar.SourceControlTextGenerationDialogForm.4eab815004',
              'CLI arguments'
            )}
          </Label>
          <Input
            id={`source-control-${actionId}-cli-args`}
            value={agentArgs}
            spellCheck={false}
            placeholder={translate(
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
            {translate(
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
            className="box-border min-w-0 w-full max-w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
          />
          <SourceControlActionVariableChips
            actionId={actionId}
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
              {translate(
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
            {translate(
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
