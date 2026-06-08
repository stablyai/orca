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
import type { TuiAgent } from '../../../../shared/types'
import { SourceControlActionVariableChips } from '../source-control/SourceControlActionVariableChips'

export type SourceControlAgentActionDeliveryPlanState =
  | { status: 'idle' }
  | { status: 'success'; summary: string; commandLabel: string; caveat: string }
  | { status: 'error'; error: string }

type SourceControlAgentActionDialogFormProps = {
  actionId: SourceControlLaunchActionId
  agentOptions: AgentCatalogEntry[]
  selectedAgent: TuiAgent | null
  hasEnabledAgents: boolean
  detecting: boolean
  statusCopy: string | null
  agentArgs: string
  commandTemplate: string
  savedCommandInputTemplate?: string | null
  baseCommandInput: string
  saveTargetValue: string
  saveTargets: { value: string; label: string }[]
  canSaveAgentDefault: boolean
  deliveryPlan: SourceControlAgentActionDeliveryPlanState
  canStart: boolean
  isStarting: boolean
  startLabel: string
  onSelectedAgentChange: (agent: TuiAgent | null) => void
  onAgentArgsChange: (value: string) => void
  onCommandTemplateChange: (value: string) => void
  onSaveAgentDefaultChange: (value: string) => void
  onOpenSettings?: () => void
  onStart: () => void
}

export function SourceControlAgentActionDialogForm({
  actionId,
  agentOptions,
  selectedAgent,
  hasEnabledAgents,
  detecting,
  statusCopy,
  agentArgs,
  commandTemplate,
  savedCommandInputTemplate,
  baseCommandInput,
  saveTargetValue,
  saveTargets,
  canSaveAgentDefault,
  deliveryPlan,
  canStart,
  isStarting,
  startLabel,
  onSelectedAgentChange,
  onAgentArgsChange,
  onCommandTemplateChange,
  onSaveAgentDefaultChange,
  onOpenSettings,
  onStart
}: SourceControlAgentActionDialogFormProps): React.JSX.Element {
  return (
    <>
      <div className="space-y-4">
        <div className="space-y-2">
          <Label className="text-xs">Agent</Label>
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
              <span>{detecting ? 'Detecting agents...' : 'No enabled agents'}</span>
              {onOpenSettings ? (
                <Button type="button" variant="ghost" size="xs" onClick={onOpenSettings}>
                  <Settings className="size-3.5" />
                  Settings
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
            CLI arguments
          </Label>
          <Input
            id="source-control-agent-cli-args"
            value={agentArgs}
            spellCheck={false}
            placeholder="--model sonnet"
            onChange={(event) => onAgentArgsChange(event.target.value)}
            className="h-8 font-mono text-xs"
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="source-control-agent-command-input" className="text-xs">
              Command template
            </Label>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onCommandTemplateChange(savedCommandInputTemplate ?? '{basePrompt}')}
            >
              <RotateCcw className="size-3.5" />
              Reset
            </Button>
          </div>
          <textarea
            id="source-control-agent-command-input"
            rows={12}
            value={commandTemplate}
            onChange={(event) => onCommandTemplateChange(event.target.value)}
            className="min-h-[14rem] w-full resize-y rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:ring-1 focus-visible:ring-ring"
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
        </div>

        {canSaveAgentDefault && selectedAgent ? (
          <div className="space-y-2">
            <Label className="text-xs">Save launch recipe</Label>
            <Select value={saveTargetValue} onValueChange={onSaveAgentDefaultChange}>
              <SelectTrigger size="sm" className="h-8 w-full text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {saveTargets.map((target) => (
                  <SelectItem key={target.value} value={target.value}>
                    {target.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
                  Launch: {deliveryPlan.commandLabel}
                </div>
                <div className="text-[11px]">{deliveryPlan.caveat}</div>
              </div>
            )}
          </div>
        ) : null}
      </div>

      <DialogFooter className="gap-2">
        <Button type="button" size="sm" disabled={!canStart} onClick={onStart}>
          {isStarting ? (
            <RefreshCw className="size-4 animate-spin" />
          ) : (
            <Sparkles className="size-4" />
          )}
          {startLabel}
        </Button>
      </DialogFooter>
    </>
  )
}
