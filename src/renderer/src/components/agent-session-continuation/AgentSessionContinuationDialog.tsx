import { agentsOfferedForLaunch } from '@/lib/host-chat-program'
import { worktreeLaunchWorkspace } from '@/lib/agent-launch-route-input'
import { useEffect, useRef, useState } from 'react'
import { Loader2, MessageSquarePlus } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { useAgentMenuObservation } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import type { AgentLaunchSurface } from '@/lib/agent-session-launch-plan'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog'
import {
  buildAgentSessionContinuationPrompt,
  hasFullAgentSessionContext,
  type AgentSessionContinuationContextMode,
  type AgentSessionContinuationRequest
} from '@/lib/agent-session-continuation'
import { launchAgentSessionContinuation } from '@/lib/launch-agent-session-continuation'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { chooseInitialContinuationAgent } from './agent-session-continuation-selection'

type AgentSessionContinuationDialogProps = {
  open: boolean
  request: AgentSessionContinuationRequest | null
  sourceWorkingDirectory?: string
  onOpenChange: (open: boolean) => void
  /** Fires after the new session launched, so a host can step aside for the new tab. */
  onStarted?: () => void
}

const EMPTY_DISABLED_AGENTS: TuiAgent[] = []

export function AgentSessionContinuationDialog({
  open,
  request,
  sourceWorkingDirectory,
  onOpenChange,
  onStarted
}: AgentSessionContinuationDialogProps): React.JSX.Element {
  const workspace = request ? worktreeLaunchWorkspace(request.worktreeId) : null
  const abortRef = useRef<AbortController | null>(null)
  const settings = useAppStore((state) => state.settings)
  const [pick, setPick] = useState<{
    request: AgentSessionContinuationRequest | null
    agent: TuiAgent
    surface?: AgentLaunchSurface
  } | null>(null)
  const detectionTarget = useAgentDetectionTargetForWorktree(request?.worktreeId ?? null)
  const [contextPick, setContextPick] = useState<{
    request: AgentSessionContinuationRequest | null
    mode: AgentSessionContinuationContextMode
  } | null>(null)
  if (!open) {
    if (pick) {
      setPick(null)
    }
    if (contextPick) {
      setContextPick(null)
    }
  }
  const contextMode = contextPick?.request === request ? contextPick.mode : 'focused'
  const [starting, setStarting] = useState(false)
  const [showStarting, setShowStarting] = useState(false)
  const disabledAgents = settings?.disabledTuiAgents ?? EMPTY_DISABLED_AGENTS

  const observation = useAgentMenuObservation(
    workspace ? { workspace, launchCwd: request?.initialCwd } : null,
    open && Boolean(request),
    detectionTarget
  )
  const { detectedIds, detectionFailed } = observation.detection
  const detecting =
    detectedIds === null && !detectionFailed && !observation.detection.needsServerUpdate
  // Agents whose chat opens without their CLI are listed too; their rows decide what is pickable.
  const offered = workspace
    ? agentsOfferedForLaunch(useAppStore.getState(), workspace, detectedIds)
    : []
  const agents = getAgentCatalog().filter(
    (agent) => offered.includes(agent.id) && isTuiAgentEnabled(agent.id, disabledAgents)
  )
  const rows = observation.model.state === 'settled' ? observation.model.rows : []
  const pickable = agents
    .map((agent) => agent.id)
    .filter((agent) => rows.some((row) => row.agent === agent && row.kind !== 'chat-unavailable'))
  const preparing = request === null
  const controlsDisabled = preparing || detecting || starting
  const hasFullContext = request ? hasFullAgentSessionContext(request.source) : false

  useEffect(() => {
    const abort = open && request ? new AbortController() : null
    abortRef.current = abort
    return () => abort?.abort()
  }, [open, request])

  const currentPick = pick?.request === request && pickable.includes(pick.agent) ? pick : null
  const selectedAgent =
    currentPick?.agent ??
    chooseInitialContinuationAgent({
      availableAgents: pickable,
      automaticAgents: pickable.filter((agent) => detectedIds?.includes(agent)),
      sourceAgent: request?.source.sourceAgent ?? null,
      defaultAgent: settings?.defaultTuiAgent
    })
  const selection = observation.selectionFor(selectedAgent, currentPick?.surface)

  useEffect(() => {
    if (!starting) {
      setShowStarting(false)
      return
    }
    // Why: local launches are often instant; defer the spinner so fast paths do not flicker.
    const timer = window.setTimeout(() => setShowStarting(true), 200)
    return () => window.clearTimeout(timer)
  }, [starting])

  const handleStart = async (): Promise<void> => {
    if (!request || detecting || !selectedAgent || starting || !selection.ready) {
      return
    }
    const prompt = buildAgentSessionContinuationPrompt(request.source, contextMode)
    if (!prompt) {
      return
    }
    setStarting(true)
    const launched = await launchAgentSessionContinuation({
      agent: selectedAgent,
      prompt,
      worktreeId: request.worktreeId,
      groupId: request.groupId,
      initialCwd: request.initialCwd,
      launchChoice: selection.choice,
      launchSource: request.launchSource,
      signal: abortRef.current?.signal
    })
    setStarting(false)
    if (launched) {
      onOpenChange(false)
      onStarted?.()
    }
  }

  const sourceName = request?.source.sourceTitle?.trim()
  const sourceAgentLabel = request?.source.sourceAgent
    ? getAgentLabel(request.source.sourceAgent)
    : null
  const startDisabled =
    controlsDisabled || agents.length === 0 || !selectedAgent || !selection.ready
  const workingDirectory = sourceWorkingDirectory ?? request?.initialCwd

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!starting) {
          onOpenChange(nextOpen)
        }
      }}
    >
      <DialogContent className="min-w-0 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <MessageSquarePlus className="size-4" />
            {translate(
              'components.agentSessionContinuation.dialogTitle',
              'Hand Off to Another Agent'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'components.agentSessionContinuation.dialogDescription',
              'Start a fresh Agent session from this stopping point. The original session stays unchanged.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-4">
          <div className="min-w-0 rounded-md border border-border bg-muted/30 px-3 py-2">
            <div className="truncate text-xs font-medium">
              {sourceName ||
                translate('components.agentSessionContinuation.untitledSession', 'Current session')}
            </div>
            <div className="mt-0.5 min-h-4 text-[11px] text-muted-foreground">
              {sourceAgentLabel
                ? translate(
                    'components.agentSessionContinuation.originalAgent',
                    'Original Agent: {{agent}}',
                    { agent: sourceAgentLabel }
                  )
                : null}
            </div>
          </div>

          <div className="min-w-0 space-y-1.5">
            <label className="text-xs font-medium">
              {translate('components.agentSessionContinuation.agent', 'Agent')}
            </label>
            <AgentCombobox
              disabled={controlsDisabled}
              agents={agents}
              value={selectedAgent}
              onValueChange={(agent) => setPick({ request, agent })}
              surfaceRows={{
                model: observation.model,
                selection,
                contextKey: observation.contextKey,
                surface: currentPick?.surface,
                onPick: (agent, surface) => setPick({ request, agent, surface })
              }}
              allowNarrowTrigger
              triggerClassName="min-w-0 w-full"
            />
            <div className="min-h-4">
              {preparing ? (
                <p className="text-[11px] text-muted-foreground">
                  {translate(
                    'components.agentSessionContinuation.preparingContext',
                    'Preparing saved chat context…'
                  )}
                </p>
              ) : detecting ? (
                <p className="text-[11px] text-muted-foreground">
                  {translate(
                    'components.agentSessionContinuation.detectingAgents',
                    'Detecting Agents on this workspace host…'
                  )}
                </p>
              ) : detectionFailed ? (
                <p className="text-[11px] text-destructive">
                  {translate(
                    'components.agentSessionContinuation.detectionFailed',
                    'Could not detect Agents on this workspace host.'
                  )}
                </p>
              ) : agents.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">
                  {translate(
                    'components.agentSessionContinuation.noAgents',
                    'No enabled Agents were detected on this workspace host.'
                  )}
                </p>
              ) : null}
            </div>
          </div>

          <div className="min-w-0 space-y-1.5">
            <label className="text-xs font-medium">
              {translate('components.agentSessionContinuation.context', 'Context')}
            </label>
            <Select
              disabled={controlsDisabled}
              value={contextMode}
              onValueChange={(value) => {
                if (value === 'focused' || value === 'full') {
                  setContextPick({ request, mode: value })
                }
              }}
            >
              <SelectTrigger className="min-w-0 w-full" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="focused">
                  {translate(
                    'components.agentSessionContinuation.modeFocused',
                    'Focused handoff (Recommended)'
                  )}
                </SelectItem>
                <SelectItem value="full" disabled={!hasFullContext}>
                  {translate(
                    'components.agentSessionContinuation.modeFull',
                    'Full session transcript'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
            <p className="min-h-12 text-[11px] leading-4 text-muted-foreground">
              {preparing
                ? null
                : !hasFullContext
                  ? request?.source.sourceKind === 'chat'
                    ? translate(
                        'components.agentSessionContinuation.modeLoadedDescription',
                        'Uses recent messages currently loaded in this chat and the current workspace.'
                      )
                    : translate(
                        'components.agentSessionContinuation.modeCapturedDescription',
                        'Uses captured text and the current workspace.'
                      )
                  : contextMode === 'focused'
                    ? translate(
                        'components.agentSessionContinuation.modeFocusedDescription',
                        'Uses the latest status and current workspace, reading older transcript details only when needed.'
                      )
                    : translate(
                        'components.agentSessionContinuation.modeFullDescription',
                        'Asks the new Agent to read the complete saved session before continuing. This can take longer and use significant context, plan usage, or API credits.'
                      )}
            </p>
          </div>

          <div className="min-h-4 text-[11px] text-muted-foreground">
            {workingDirectory ? (
              <>
                {translate('components.agentSessionContinuation.startsIn', 'Starts in:')}{' '}
                <span className="break-all font-mono text-foreground/80">{workingDirectory}</span>
              </>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            disabled={starting}
            onClick={() => onOpenChange(false)}
          >
            {translate('components.native-chat.question.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            autoFocus
            disabled={startDisabled}
            onClick={() => void handleStart()}
          >
            {showStarting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {starting
              ? translate('components.agentSessionContinuation.starting', 'Starting…')
              : translate('components.agentSessionContinuation.startSession', 'Start New Session')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
