import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
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
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import { SourceControlAgentActionDialogForm } from './SourceControlAgentActionDialogForm'
import { useSourceControlAgentActionDialog } from './useSourceControlAgentActionDialog'
import { SourceControlExistingAgentSendMenu } from './SourceControlExistingAgentSendMenu'

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
  /**
   * Fires when the agent tab is created, before deferred prompt delivery finishes.
   * Reversible bookkeeping only; irreversible host writes belong in onLaunched.
   */
  onLaunchAccepted?: () => void
  /** Fires when an accepted launch later failed to deliver its prompt. */
  onLaunchAborted?: () => void
  onLaunched?: () => void
  /**
   * Offers sending the rendered prompt to a running agent of `worktreeId` instead of starting
   * one. Reuses the launch callbacks: accepted before the send, aborted on failure, and
   * onLaunched only once the prompt was delivered.
   */
  allowExistingAgentSession?: boolean
  startLabel?: string
  onStart?: (args: {
    agent: TuiAgent
    commandInput: string
    /** Omitted when CLI arguments do not apply to this launch, so it resolves the global setting. */
    agentArgs?: string
  }) => boolean | Promise<boolean>
}

/**
 * Why: an existing-session send outlives the open cycle that started it. Closing, reopening,
 * switching action, or unmounting retires the cycle, so a late result can still settle its own
 * send but never closes or disables a newer composer.
 */
function useExistingAgentSendCycle(
  open: boolean,
  actionId: SourceControlLaunchActionId
): { cycle: number; isLiveCycle: (cycle: number) => boolean } {
  const cycleCounterRef = useRef(0)
  const liveCycleRef = useRef<number | null>(null)
  const [cycle, setCycle] = useState(0)
  // Why layout: the live cycle must change in the same commit as `open`/`actionId`, before a
  // pending send's microtask can observe the old one.
  useLayoutEffect(() => {
    cycleCounterRef.current += 1
    const nextCycle = cycleCounterRef.current
    liveCycleRef.current = nextCycle
    setCycle(nextCycle)
    return () => {
      liveCycleRef.current = null
    }
  }, [open, actionId])
  const isLiveCycle = useCallback((candidate: number) => liveCycleRef.current === candidate, [])
  return { cycle, isLiveCycle }
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
    onSaveAgentDefault,
    allowExistingAgentSession,
    worktreeId,
    launchSource,
    onLaunchAccepted,
    onLaunchAborted,
    onLaunched
  } = props
  const { cycle: sendCycle, isLiveCycle } = useExistingAgentSendCycle(open, actionId)
  const [pendingSendCycle, setPendingSendCycle] = useState<number | null>(null)
  const existingSendPending = pendingSendCycle === sendCycle
  const {
    handleOpenChange,
    shouldRenderDialog,
    agentScopeNote,
    agentOptions,
    selectedAgent,
    hasEnabledAgents,
    detecting,
    statusCopy,
    agentArgs,
    agentArgsApply,
    commandTemplate,
    trimmedCommandInput,
    connectionUnavailable,
    saveLaunchRecipe,
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
    onSaveLaunchRecipeChange,
    onSaveAgentDefaultChange,
    handleStart
  } = useSourceControlAgentActionDialog(props)

  const existingAgentSendMenu =
    allowExistingAgentSession && worktreeId ? (
      <SourceControlExistingAgentSendMenu
        worktreeId={worktreeId}
        prompt={trimmedCommandInput}
        launchSource={launchSource}
        disabled={
          !trimmedCommandInput || connectionUnavailable || isStarting || existingSendPending
        }
        onSendStarted={() => {
          setPendingSendCycle(sendCycle)
          onLaunchAccepted?.()
        }}
        onPromptDelivered={() => {
          setPendingSendCycle((current) => (current === sendCycle ? null : current))
          // Why: the ack belongs to the send that delivered, even after its composer closed.
          onLaunched?.()
          if (isLiveCycle(sendCycle)) {
            handleOpenChange(false)
          }
        }}
        // Why: the dialog stays open with the edited prompt so the user can retry or start a new agent.
        onSendFailed={() => {
          setPendingSendCycle((current) => (current === sendCycle ? null : current))
          onLaunchAborted?.()
        }}
      />
    ) : null

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* Why: saved receipts auto-start in the background, so the fallback content
          stays unmounted to avoid flashing a dialog the user already skipped. */}
      {shouldRenderDialog ? (
        <DialogContent className="flex max-h-[min(82vh,42rem)] min-w-0 flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader className="shrink-0">
            <DialogTitle className="text-sm">{title}</DialogTitle>
            <DialogDescription className="text-xs">{description}</DialogDescription>
          </DialogHeader>
          <SourceControlAgentActionDialogForm
            actionId={actionId}
            baseCommandInput={baseCommandInput}
            agentScopeNote={agentScopeNote}
            agentOptions={agentOptions}
            selectedAgent={selectedAgent}
            hasEnabledAgents={hasEnabledAgents}
            detecting={detecting}
            statusCopy={statusCopy}
            agentArgs={agentArgs}
            agentArgsApply={agentArgsApply}
            commandTemplate={commandTemplate}
            savedCommandInputTemplate={savedCommandInputTemplate}
            saveLaunchRecipe={saveLaunchRecipe}
            saveTargetValue={saveTargetValue}
            saveTargets={saveTargets}
            settings={settings}
            repo={repo}
            canSaveAgentDefault={Boolean(onSaveAgentDefault)}
            deliveryPlan={deliveryPlan}
            canStart={canStart && !existingSendPending}
            isStarting={isStarting}
            existingAgentSendMenu={existingAgentSendMenu}
            startLabel={startLabel}
            onSelectedAgentChange={onSelectedAgentChange}
            onAgentArgsChange={onAgentArgsChange}
            onCommandTemplateChange={onCommandTemplateChange}
            onSaveLaunchRecipeChange={onSaveLaunchRecipeChange}
            onSaveAgentDefaultChange={onSaveAgentDefaultChange}
            onOpenSettings={onOpenSettings}
            onCancel={() => handleOpenChange(false)}
            onStart={() => void handleStart()}
          />
        </DialogContent>
      ) : null}
    </Dialog>
  )
}
