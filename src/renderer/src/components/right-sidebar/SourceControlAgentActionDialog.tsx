import React from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId
} from '../../../../shared/source-control-ai-actions'
import type { TuiAgent } from '../../../../shared/types'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { SourceControlAgentActionDialogForm } from './SourceControlAgentActionDialogForm'
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'

export type SourceControlAgentActionDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  actionId: SourceControlLaunchActionId
  title: string
  description: string
  baseCommandInput: string
  savedCommandInputTemplate?: string | null
  savedAgentArgs?: string | null
  worktreeId?: string | null
  groupId?: string | null
  connectionId?: string | null
  repoId?: string | null
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchPlatform?: NodeJS.Platform
  launchSource: LaunchSource
  savedAgentId?: TuiAgent | null
  onSaveAgentDefault?: (
    target: SourceControlAiWriteTarget,
    actionId: SourceControlLaunchActionId,
    recipe: SourceControlActionRecipe
  ) => void | Promise<void>
  onOpenSettings?: () => void
  onLaunched?: () => void
  startLabel?: string
  onStart?: (args: {
    agent: TuiAgent
    commandInput: string
    agentArgs: string
  }) => boolean | Promise<boolean>
}

export function SourceControlAgentActionDialog(
  props: SourceControlAgentActionDialogProps
): React.JSX.Element {
  const {
    open,
    actionId,
    title,
    description,
    baseCommandInput,
    savedCommandInputTemplate,
    onOpenSettings,
    startLabel = 'Start agent',
    onSaveAgentDefault
  } = props
  const {
    handleOpenChange,
    agentOptions,
    selectedAgent,
    hasEnabledAgents,
    detecting,
    statusCopy,
    agentArgs,
    commandTemplate,
    saveTargetValue,
    saveTargets,
    settings,
    repo,
    deliveryPlan,
    canStart,
    isStarting,
    onSelectedAgentChange,
    onAgentArgsChange,
    onCommandTemplateChange,
    onSaveAgentDefaultChange,
    handleStart
  } = useSourceControlAgentActionDialog(props)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="min-w-0 overflow-x-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="text-xs">{description}</DialogDescription>
        </DialogHeader>
        <SourceControlAgentActionDialogForm
          actionId={actionId}
          agentOptions={agentOptions}
          selectedAgent={selectedAgent}
          hasEnabledAgents={hasEnabledAgents}
          detecting={detecting}
          statusCopy={statusCopy}
          agentArgs={agentArgs}
          commandTemplate={commandTemplate}
          savedCommandInputTemplate={savedCommandInputTemplate}
          baseCommandInput={baseCommandInput}
          saveTargetValue={saveTargetValue}
          saveTargets={saveTargets}
          settings={settings}
          repo={repo}
          canSaveAgentDefault={Boolean(onSaveAgentDefault)}
          deliveryPlan={deliveryPlan}
          canStart={canStart}
          isStarting={isStarting}
          startLabel={startLabel}
          onSelectedAgentChange={onSelectedAgentChange}
          onAgentArgsChange={onAgentArgsChange}
          onCommandTemplateChange={onCommandTemplateChange}
          onSaveAgentDefaultChange={onSaveAgentDefaultChange}
          onOpenSettings={onOpenSettings}
          onStart={() => void handleStart()}
        />
      </DialogContent>
    </Dialog>
  )
}
