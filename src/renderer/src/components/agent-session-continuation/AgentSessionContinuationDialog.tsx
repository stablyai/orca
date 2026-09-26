import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquarePlus } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
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
  SelectGroup,
  SelectItem,
  SelectLabel,
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
import {
  detectAgentSessionContinuationAgents,
  launchAgentSessionContinuation
} from '@/lib/launch-agent-session-continuation'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { chooseInitialContinuationAgent } from './agent-session-continuation-selection'
import { useContinuationTargetSelection } from './use-continuation-target-selection'
import { prepareContinuationSourceForTarget } from './continuation-handoff'
import { isContinuationTargetSelectable } from './continuation-target-options'
import { toast } from 'sonner'
import { getExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { AI_VAULT_HANDOFF_MAX_TRANSFER_MB } from '../../../../shared/ai-vault-session-handoff'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'

type AgentSessionContinuationDialogProps = {
  open: boolean
  request: AgentSessionContinuationRequest | null
  onOpenChange: (open: boolean) => void
}

const EMPTY_DISABLED_AGENTS: TuiAgent[] = []

export function AgentSessionContinuationDialog({
  open,
  request,
  onOpenChange
}: AgentSessionContinuationDialogProps): React.JSX.Element {
  const settings = useAppStore((state) => state.settings)
  const [detectedAgents, setDetectedAgents] = useState<TuiAgent[]>([])
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(null)
  const [contextMode, setContextMode] = useState<AgentSessionContinuationContextMode>('focused')
  const [detecting, setDetecting] = useState(true)
  const [detectionFailed, setDetectionFailed] = useState(false)
  const [starting, setStarting] = useState(false)
  const [showStarting, setShowStarting] = useState(false)
  const disabledAgents = settings?.disabledTuiAgents ?? EMPTY_DISABLED_AGENTS
  const target = useContinuationTargetSelection({ open, request })
  const targetWorkspaceId = target.selectedOption?.workspaceId ?? request?.worktreeId ?? null
  const showTargetPicker = Boolean(request?.origin) && target.groups.length > 0

  const agents = useMemo(
    () =>
      getAgentCatalog().filter(
        (agent) => detectedAgents.includes(agent.id) && isTuiAgentEnabled(agent.id, disabledAgents)
      ),
    [detectedAgents, disabledAgents]
  )
  const hasFullContext = request ? hasFullAgentSessionContext(request.source) : false

  useEffect(() => {
    if (!open || !request) {
      return
    }
    let cancelled = false
    setDetecting(true)
    setDetectionFailed(false)
    setDetectedAgents([])
    setSelectedAgent(null)
    setContextMode('focused')
    void detectAgentSessionContinuationAgents(targetWorkspaceId ?? request.worktreeId)
      .then((detected) => {
        if (cancelled) {
          return
        }
        const enabled = detected.filter((agent) => isTuiAgentEnabled(agent, disabledAgents))
        setDetectedAgents(enabled)
        setSelectedAgent(
          chooseInitialContinuationAgent({
            availableAgents: enabled,
            sourceAgent: request.source.sourceAgent,
            defaultAgent: settings?.defaultTuiAgent
          })
        )
      })
      .catch((error) => {
        console.error('Agent detection failed for continuation dialog', error)
        if (!cancelled) {
          setDetectedAgents([])
          setSelectedAgent(null)
          setDetectionFailed(true)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setDetecting(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [disabledAgents, open, request, settings?.defaultTuiAgent, targetWorkspaceId])

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
    if (!request || !selectedAgent || starting) {
      return
    }
    const option = target.selectedOption
    const movesWorkspace = Boolean(option && option.workspaceId !== request.worktreeId)
    setStarting(true)

    const prepared = await prepareContinuationSourceForTarget({
      source: request.source,
      origin: request.origin,
      bridge: option?.bridge ?? { kind: 'same-host' },
      targetExecutionHostId: option?.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
      sourceHostLabel: target.sourceHostLabel,
      targetHostLabel: getExecutionHostDisplayLabel(
        option?.executionHostId ?? LOCAL_EXECUTION_HOST_ID,
        target.hostNames
      )
    })
    if (prepared.kind === 'failed') {
      setStarting(false)
      toast.error(prepared.message)
      return
    }
    // Why: a transcript too large to move cannot honour the full-transcript mode.
    const effectiveMode = prepared.degradedToDigest ? 'focused' : contextMode
    const prompt = buildAgentSessionContinuationPrompt(prepared.source, effectiveMode)
    if (!prompt) {
      setStarting(false)
      return
    }

    const launched = await launchAgentSessionContinuation({
      agent: selectedAgent,
      prompt,
      worktreeId: option?.workspaceId ?? request.worktreeId,
      ...(movesWorkspace ? {} : { groupId: request.groupId }),
      workspacePath: option?.workspacePath ?? request.workspacePath,
      initialCwd: movesWorkspace ? option?.workspacePath : request.initialCwd,
      launchSource: request.launchSource
    })
    setStarting(false)
    if (launched) {
      onOpenChange(false)
    }
  }

  const sourceName = request?.source.sourceTitle?.trim()
  const sourceAgentLabel = request?.source.sourceAgent
    ? getAgentLabel(request.source.sourceAgent)
    : null
  // Why: the collapsed trigger must still say which host the session lands on.
  const targetTriggerLabel = target.selectedOption
    ? `${getExecutionHostDisplayLabel(target.selectedOption.executionHostId, target.hostNames)} · ${target.selectedOption.label}`
    : undefined
  const startsInPath = target.selectedOption?.workspacePath ?? request?.initialCwd ?? null
  // Why: the target never blocks starting — an unreachable transcript degrades the
  // context instead, so this keeps the original same-workspace flow always available.
  const startDisabled = detecting || starting || agents.length === 0 || !selectedAgent

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
              'Continue in New Session'
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
            {sourceAgentLabel ? (
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {translate(
                  'components.agentSessionContinuation.originalAgent',
                  'Original Agent: {{agent}}',
                  { agent: sourceAgentLabel }
                )}
              </div>
            ) : null}
          </div>

          {showTargetPicker ? (
            <div className="min-w-0 space-y-1.5">
              <label className="text-xs font-medium">
                {translate('components.agentSessionContinuation.continueOn', 'Continue on')}
              </label>
              <Select
                value={targetWorkspaceId ?? undefined}
                onValueChange={target.setSelectedWorkspaceId}
              >
                <SelectTrigger className="min-w-0 w-full" size="sm">
                  <SelectValue>{targetTriggerLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {target.groups.map((group) => (
                    <SelectGroup key={group.executionHostId}>
                      <SelectLabel>{group.hostLabel}</SelectLabel>
                      {group.options.map((option) => (
                        <SelectItem
                          key={option.workspaceId}
                          value={option.workspaceId}
                          disabled={!isContinuationTargetSelectable(option)}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="min-w-0 space-y-1.5">
            <label className="text-xs font-medium">
              {translate('components.agentSessionContinuation.agent', 'Agent')}
            </label>
            <AgentCombobox
              agents={agents}
              value={selectedAgent}
              onValueChange={setSelectedAgent}
              allowBlankTerminal={false}
              allowNarrowTrigger
              emptyLabel={translate(
                'components.agentSessionContinuation.selectAgent',
                'Select an Agent'
              )}
              triggerClassName="min-w-0 w-full"
            />
            {detecting ? (
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

          <div className="min-w-0 space-y-1.5">
            <label className="text-xs font-medium">
              {translate('components.agentSessionContinuation.context', 'Context')}
            </label>
            <Select
              value={contextMode}
              onValueChange={(value) =>
                setContextMode(value as AgentSessionContinuationContextMode)
              }
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
                <SelectItem
                  value="full"
                  disabled={!hasFullContext || target.fullTranscriptBlockedReason !== null}
                >
                  {translate(
                    'components.agentSessionContinuation.modeFull',
                    'Full session transcript'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
            {target.fullTranscriptBlockedReason && hasFullContext ? (
              <p className="text-[11px] leading-4 text-status-warning">
                {target.fullTranscriptBlockedReason === 'too-large'
                  ? translate(
                      'components.agentSessionContinuation.transcriptTooLarge',
                      'This transcript is over {{limit}}, too large to copy to another host. The new session gets its most recent portion instead.',
                      { limit: AI_VAULT_HANDOFF_MAX_TRANSFER_MB }
                    )
                  : translate(
                      'components.agentSessionContinuation.transcriptNotStorableOnHost',
                      'This host cannot store a transcript file, so the new session gets the most recent portion of it instead.'
                    )}
              </p>
            ) : null}
            <p className="text-[11px] leading-4 text-muted-foreground">
              {contextMode === 'focused'
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

          {startsInPath ? (
            <div className="text-[11px] text-muted-foreground">
              {translate('components.agentSessionContinuation.startsIn', 'Starts in:')}{' '}
              <span className="break-all font-mono text-foreground/80">{startsInPath}</span>
            </div>
          ) : null}
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
