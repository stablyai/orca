import { useAgentPickerDraftScope } from '../agent/AgentLaunchSetupButton'
import { agentsOfferedForLaunch } from '@/lib/agent-session/launch/inventory/host-chat-program'
import { worktreeLaunchWorkspace } from '@/lib/agent-session/launch/routing/agent-launch-route-input'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { AgentLaunchPicker } from '@/components/agent/AgentLaunchPicker'
import {
  agentPickerFreshLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { useAgentMenuObservation } from '@/components/agent/launch-menu/use-new-tab-agent-menu-rows'
import { useAgentDetectionTargetForWorktree } from '@/lib/agent-session/launch/inventory/useAgentDetectionTarget'
import type { AgentLaunchSurface } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel, DialogError } from '@/components/ui/dialog-parts'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentCatalog, getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import {
  buildAgentSessionContinuationPrompt,
  hasFullAgentSessionContext,
  type AgentSessionContinuationContextMode,
  type AgentSessionContinuationRequest
} from '../../../../shared/agent-session/context/agent-session-continuation'
import { launchAgentSessionContinuation } from '@/lib/agent-session/launch/continuation/launch-agent-session-continuation'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../../shared/agent-launch/catalog/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import {
  chooseInitialContinuationAgent,
  isContinuationAgentAllowed
} from './agent-session-continuation-selection'

type AgentSessionContinuationDialogProps = {
  open: boolean
  request: AgentSessionContinuationRequest | null
  onOpenChange: (open: boolean) => void
  /** Fires after the new session launched, so a host can step aside for the new tab. */
  onStarted?: () => void
}

const EMPTY_DISABLED_AGENTS: TuiAgent[] = []

export function AgentSessionContinuationDialog({
  open,
  request,
  onOpenChange,
  onStarted
}: AgentSessionContinuationDialogProps): React.JSX.Element {
  const t = useTranslate()
  const workspace = request ? worktreeLaunchWorkspace(request.worktreeId) : null
  const abortRef = useRef<AbortController | null>(null)
  const agentFieldRef = useRef<HTMLDivElement>(null)
  const contextLabelId = useId()
  const settings = useAppStore((state) => state.settings)
  const [pick, setPick] = useState<{
    request: AgentSessionContinuationRequest | null
    agent: TuiAgent
    surface?: AgentLaunchSurface
    draft?: AgentPickerDraft
    entry?: AgentPickerEntry
  } | null>(null)
  const detectionTarget = useAgentDetectionTargetForWorktree(request?.worktreeId ?? null)
  const [contextPick, setContextPick] = useState<{
    request: AgentSessionContinuationRequest | null
    mode: AgentSessionContinuationContextMode
  } | null>(null)
  // One start's own token: a closed or reopened dialog no longer waits on a start it left behind.
  const [startingFor, setStartingFor] = useState<{
    request: AgentSessionContinuationRequest
  } | null>(null)
  if (!open) {
    if (pick) {
      setPick(null)
    }
    if (contextPick) {
      setContextPick(null)
    }
    if (startingFor) {
      setStartingFor(null)
    }
  }
  const contextMode = contextPick?.request === request ? contextPick.mode : 'focused'
  const starting = open && startingFor?.request === request
  const [showStarting, setShowStarting] = useState(false)
  const disabledAgents = settings?.disabledTuiAgents ?? EMPTY_DISABLED_AGENTS

  const observation = useAgentMenuObservation(
    workspace ? { workspace, launchCwd: request?.initialCwd } : null,
    open && Boolean(request),
    detectionTarget,
    { wakeOnOpen: true }
  )
  const { detectedIds, detectionFailed } = observation.detection
  const detecting =
    detectedIds === null && !detectionFailed && !observation.detection.needsServerUpdate
  // Agents whose chat opens without their CLI are listed too; their rows decide what is pickable.
  const offered = workspace
    ? agentsOfferedForLaunch(useAppStore.getState(), workspace, detectedIds)
    : []
  const agents = getAgentCatalog().filter(
    (agent) =>
      isTuiAgentEnabled(agent.id, disabledAgents) &&
      isContinuationAgentAllowed(agent.id, request?.source.sourceAgent, request?.avoidSourceAgent)
  )
  const destinationModel =
    observation.model.state === 'settled'
      ? {
          ...observation.model,
          rows: observation.model.rows.filter((row) =>
            agents.some((agent) => agent.id === row.agent)
          )
        }
      : observation.model
  const rows = destinationModel.state === 'settled' ? destinationModel.rows : []
  const pickable = agents
    .map((agent) => agent.id)
    .filter(
      (agent) =>
        offered.includes(agent) &&
        rows.some((row) => row.agent === agent && row.kind !== 'chat-unavailable')
    )
  // Why: the explanation must read the same host rows the picker shows, before the family filter.
  const openableRows =
    observation.model.state === 'settled'
      ? observation.model.rows.filter((row) => row.kind !== 'chat-unavailable')
      : []
  const onlySourceFamilyOffered =
    openableRows.length > 0 &&
    openableRows.every(
      (row) =>
        !isContinuationAgentAllowed(
          row.agent,
          request?.source.sourceAgent,
          request?.avoidSourceAgent
        )
    )
  const preparing = request === null
  const controlsDisabled = preparing || detecting || starting
  const hasFullContext = request ? hasFullAgentSessionContext(request.source) : false

  useLayoutEffect(() => {
    const field = agentFieldRef.current
    if (open && !controlsDisabled && document.activeElement === field) {
      field?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    }
  }, [open, controlsDisabled, destinationModel.state])

  useEffect(() => {
    const abort = open && request ? new AbortController() : null
    abortRef.current = abort
    return () => abort?.abort()
  }, [open, request])

  const draftScope = useAgentPickerDraftScope(request)
  const currentPick = pick?.request === request && pickable.includes(pick.agent) ? pick : null
  const selectedAgent =
    currentPick?.agent ??
    chooseInitialContinuationAgent({
      availableAgents: pickable,
      automaticAgents: pickable.filter((agent) => detectedIds?.includes(agent)),
      sourceAgent: request?.avoidSourceAgent ? null : (request?.source.sourceAgent ?? null),
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
    if (
      !request ||
      detecting ||
      !selectedAgent ||
      starting ||
      !selection.ready ||
      !selection.choice
    ) {
      return
    }
    const prompt = buildAgentSessionContinuationPrompt(request.source, contextMode)
    if (!prompt) {
      return
    }
    const start = { request }
    // Aborts when the dialog closes or moves to another request; a sent launch still settles.
    const signal = abortRef.current?.signal
    setStartingFor(start)
    const launched = await launchAgentSessionContinuation({
      agent: selectedAgent,
      prompt,
      worktreeId: request.worktreeId,
      groupId: request.groupId,
      initialCwd: request.initialCwd,
      launchChoice: selection.choice,
      ...(currentPick?.draft
        ? agentPickerFreshLaunchInputs(
            currentPick.draft,
            {
              surface: selection.choice.route === 'terminal-tui' ? 'terminal' : 'chat',
              executionHostId: selection.choice.executionHostId
            },
            currentPick.entry
          )
        : {}),
      launchSource: request.launchSource,
      signal
    })
    setStartingFor((current) => (current === start ? null : current))
    // A late finish is reported by the launch's own owners, never by a dialog it no longer holds.
    if (launched && !signal?.aborted) {
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
  const sourceLabel =
    sourceName || t('components.agentSessionContinuation.untitledSession', 'Current session')

  const agentStatus = preparing
    ? t('components.agentSessionContinuation.preparingContext', 'Preparing saved chat context…')
    : detecting
      ? t(
          'components.agentSessionContinuation.detectingAgents',
          'Detecting Agents on this workspace host…'
        )
      : destinationModel.state === 'settled' && rows.length === 0 && !detectionFailed
        ? onlySourceFamilyOffered && sourceAgentLabel
          ? t(
              'components.agentSessionContinuation.onlySourceFamilyDetected',
              'Only Agents sharing the usage limit with {{agent}} are available on this workspace host. Enable or install a different Agent.',
              { agent: sourceAgentLabel }
            )
          : t(
              'components.agentSessionContinuation.noAgents',
              'No enabled agents were detected on this workspace host.'
            )
        : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="form"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          const field = agentFieldRef.current
          ;(field?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? field)?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(
              'components.agentSessionContinuation.dialogTitleSentence',
              'Hand off to another agent'
            )}
          </DialogTitle>
          <DialogDescription size="compact">
            {sourceAgentLabel
              ? t(
                  'components.agentSessionContinuation.metaWithAgent',
                  'From {{agent}} · {{session}} · original stays unchanged',
                  { agent: sourceAgentLabel, session: sourceLabel }
                )
              : t(
                  'components.agentSessionContinuation.meta',
                  '{{session}} · original stays unchanged',
                  { session: sourceLabel }
                )}
          </DialogDescription>
        </DialogHeader>

        <div
          className="grid min-w-0 gap-1.5 outline-none"
          ref={agentFieldRef}
          tabIndex={-1}
          role="group"
          aria-label={t('components.agentSessionContinuation.agent', 'Agent')}
        >
          <label className="text-[13px] font-medium">
            {t('components.agentSessionContinuation.agent', 'Agent')}
          </label>
          <AgentLaunchPicker
            draftScope={draftScope}
            disabled={controlsDisabled}
            model={destinationModel}
            worktreeId={request?.worktreeId}
            agent={selectedAgent}
            cli={selection.cli}
            value={currentPick?.draft}
            onPick={(agent, draft, entry) =>
              setPick({ request, agent, surface: draft?.surface, draft, entry })
            }
          />
          {agentStatus ? <p className="text-xs text-muted-foreground">{agentStatus}</p> : null}
          {detectionFailed && !preparing && !detecting ? (
            <DialogError>
              {t(
                'components.agentSessionContinuation.detectionFailed',
                'Could not detect Agents on this workspace host.'
              )}
            </DialogError>
          ) : null}
        </div>

        <div className="grid min-w-0 gap-1.5">
          <label id={contextLabelId} className="text-[13px] font-medium">
            {t('components.agentSessionContinuation.context', 'Context')}
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
            <SelectTrigger aria-labelledby={contextLabelId} className="min-w-0 w-full" size="sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="focused">
                {t(
                  'components.agentSessionContinuation.modeLatestStatus',
                  'Latest status (recommended)'
                )}
              </SelectItem>
              <SelectItem value="full" disabled={!hasFullContext}>
                {t('components.agentSessionContinuation.modeFullTranscript', 'Full transcript')}
              </SelectItem>
            </SelectContent>
          </Select>
          {contextMode === 'full' ? (
            // Why only here: the cost warning is the one thing this choice needs to say.
            <p className="text-xs text-muted-foreground">
              {t(
                'components.agentSessionContinuation.modeFullCost',
                'Slower, and uses more of your plan or API credits.'
              )}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <DialogCancel>{t('components.native-chat.question.cancel', 'Cancel')}</DialogCancel>
          <Button
            type="button"
            size="sm"
            disabled={startDisabled}
            onClick={() => void handleStart()}
          >
            {showStarting ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {starting
              ? t('components.agentSessionContinuation.starting', 'Starting…')
              : t('components.agentSessionContinuation.startSessionSentence', 'Start session')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
