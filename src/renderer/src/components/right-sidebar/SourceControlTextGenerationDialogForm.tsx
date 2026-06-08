import React, { useCallback, useMemo, useState } from 'react'
import { CheckCircle2, RefreshCw, Save, Sparkles, Terminal, TriangleAlert } from 'lucide-react'
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
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { planSourceControlTextGeneration } from '@/lib/source-control-generation-plan'
import {
  CUSTOM_AGENT_ID,
  isCustomAgentId,
  listCommitMessageAgentCapabilities
} from '../../../../shared/commit-message-agent-spec'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../shared/source-control-ai'
import type { SourceControlTextActionId } from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import type { GlobalSettings, TuiAgent } from '../../../../shared/types'
import { toast } from 'sonner'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'
import {
  buildCommitMessageGenerationParams,
  type CommitMessageGenerationAgentChoice
} from './SourceControlTextGenerationParams'

const UNCONFIGURED_AGENT_SELECT_VALUE = ''

type PlanState =
  | { status: 'idle' }
  | { status: 'success'; commandLabel: string; delivery: string; caveat: string }
  | { status: 'error'; error: string }

export type SourceControlTextGenerationSaveTarget = {
  target: SourceControlAiWriteTarget
  label: string
  successMessage: string
}

type SourceControlTextGenerationDialogFormProps = {
  actionId: SourceControlTextActionId
  generateLabel: string
  settings: GlobalSettings | null
  baseParams: ResolvedSourceControlAiGenerationParams | null
  saveTargets: SourceControlTextGenerationSaveTarget[]
  onGenerate: (params: ResolvedSourceControlAiGenerationParams) => void
  onOpenChange: (open: boolean) => void
  onSaveDefaults: (
    target: SourceControlAiWriteTarget,
    params: ResolvedSourceControlAiGenerationParams
  ) => Promise<void> | void
}

function agentLabel(agentId: TuiAgent): string {
  return AGENT_CATALOG.find((agent) => agent.id === agentId)?.label ?? agentId
}

export function SourceControlTextGenerationDialogForm({
  actionId,
  generateLabel,
  settings,
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
  const [plan, setPlan] = useState<PlanState>({ status: 'idle' })
  const [savingTargetKey, setSavingTargetKey] = useState<string | null>(null)
  const commandTemplateId = `source-control-${actionId}-command-template`

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

  const handlePlan = (): void => {
    if (!params || !paramsPlanResult) {
      setPlan({ status: 'error', error: 'Choose an agent before checking generation.' })
      return
    }
    setPlan(
      paramsPlanResult.ok
        ? {
            status: 'success',
            commandLabel: paramsPlanResult.commandLabel,
            delivery: paramsPlanResult.delivery,
            caveat: paramsPlanResult.caveat
          }
        : { status: 'error', error: paramsPlanResult.error }
    )
  }

  const saveCurrentDefaults = useCallback(
    async (
      saveTarget: SourceControlTextGenerationSaveTarget,
      options: { showToast: boolean; showErrors: boolean }
    ): Promise<boolean> => {
      if (!params || saving || !paramsPlanResult?.ok) {
        if (options.showErrors && paramsPlanResult && !paramsPlanResult.ok) {
          setPlan({ status: 'error', error: paramsPlanResult.error })
        }
        return false
      }
      const targetKey =
        saveTarget.target.type === 'repo' ? `repo:${saveTarget.target.repoId}` : 'global'
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
      if (paramsPlanResult && !paramsPlanResult.ok) {
        setPlan({ status: 'error', error: paramsPlanResult.error })
      }
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
      <div className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Agent</Label>
          <Select
            value={agentId || UNCONFIGURED_AGENT_SELECT_VALUE}
            onValueChange={(value) => {
              if (value === UNCONFIGURED_AGENT_SELECT_VALUE) {
                return
              }
              setAgentId(value === CUSTOM_AGENT_ID ? CUSTOM_AGENT_ID : (value as TuiAgent))
              setPlan({ status: 'idle' })
            }}
          >
            <SelectTrigger size="sm" className="h-8 text-xs">
              <SelectValue placeholder="Choose agent" />
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
                    Custom command
                  </span>
                </SelectItem>
              ) : null}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor={`source-control-${actionId}-cli-args`} className="text-xs">
            CLI arguments
          </Label>
          <Input
            id={`source-control-${actionId}-cli-args`}
            value={agentArgs}
            spellCheck={false}
            placeholder="--model sonnet"
            onChange={(event) => {
              setAgentArgs(event.target.value)
              setPlan({ status: 'idle' })
            }}
            className="h-8 font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor={commandTemplateId} className="text-xs">
            Command template
          </Label>
          <textarea
            id={commandTemplateId}
            rows={8}
            value={commandTemplate}
            spellCheck={false}
            onChange={(event) => {
              setCommandTemplate(event.target.value)
              setPlan({ status: 'idle' })
            }}
            className="w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
          />
          <SourceControlActionVariableChips
            actionId={actionId}
            onInsert={(variable) => {
              const separator =
                commandTemplate.endsWith('\n') || commandTemplate.length === 0 ? '' : ' '
              setCommandTemplate(`${commandTemplate}${separator}{${variable}}`)
              setPlan({ status: 'idle' })
            }}
          />
        </div>

        {plan.status !== 'idle' ? (
          <div
            className={
              plan.status === 'error'
                ? 'rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive'
                : 'space-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground'
            }
          >
            {plan.status === 'error' ? (
              <span className="flex items-start gap-2">
                <TriangleAlert className="mt-px size-3.5 shrink-0" />
                {plan.error}
              </span>
            ) : (
              <>
                <div className="flex items-start gap-2 text-foreground">
                  <CheckCircle2 className="mt-px size-3.5 shrink-0 text-status-success" />
                  {plan.delivery}
                </div>
                <div className="truncate font-mono text-[11px]">Launch: {plan.commandLabel}</div>
                <div className="text-[11px]">{plan.caveat}</div>
              </>
            )}
          </div>
        ) : null}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" variant="outline" size="sm" onClick={handlePlan}>
          <CheckCircle2 className="size-4" />
          Check generation
        </Button>
        {saveTargets.map((saveTarget) => {
          const targetKey =
            saveTarget.target.type === 'repo' ? `repo:${saveTarget.target.repoId}` : 'global'
          return (
            <Button
              key={targetKey}
              type="button"
              variant="outline"
              size="sm"
              disabled={!canRunGeneration || saving}
              onClick={() => void handleSaveDefaults(saveTarget)}
            >
              {savingTargetKey === targetKey ? (
                <RefreshCw className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {saveTarget.label}
            </Button>
          )
        })}
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
