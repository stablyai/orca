import { useEffect, useMemo, useState } from 'react'
import { Loader2, MessageSquarePlus } from 'lucide-react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import {
  detectAgentSessionContinuationAgents,
  launchAgentSessionContinuation
} from '@/lib/launch-agent-session-continuation'
import { launchAgentSessionContinuationInNewWorktree } from '@/lib/launch-agent-session-continuation-worktree'
import { useAppStore } from '@/store'
import { isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { chooseInitialContinuationAgent } from './agent-session-continuation-selection'

type AgentSessionContinuationDialogProps = {
  open: boolean
  request: AgentSessionContinuationRequest | null
  onOpenChange: (open: boolean) => void
}

const EMPTY_DISABLED_AGENTS: TuiAgent[] = []

type ContinuationDestination = 'current' | 'new-worktree'

// Why: the source tab title usually already carries the ticket id, so the branch
// name is a confirmation rather than a fresh decision.
function suggestBranchName(sourceTitle: string | null | undefined): string {
  const title = sourceTitle?.trim() ?? ''
  const ticket = /[A-Z]{2,}[-/]\d+/.exec(title)?.[0]
  if (ticket) {
    return ticket.replace('/', '-')
  }
  return title
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

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
  const [destination, setDestination] = useState<ContinuationDestination>('current')
  const [branchName, setBranchName] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const repos = useAppStore((state) => state.repos)
  const disabledAgents = settings?.disabledTuiAgents ?? EMPTY_DISABLED_AGENTS
  const sourceRepoId = request
    ? (splitWorktreeIdForFilesystem(request.worktreeId)?.repoId ?? null)
    : null
  // Why: folder workspaces have no branches, so a new worktree is not a destination there.
  const canCreateWorktree = useMemo(() => {
    const repo = sourceRepoId ? repos.find((entry) => entry.id === sourceRepoId) : null
    return Boolean(repo && isGitRepoKind(repo))
  }, [repos, sourceRepoId])

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
    setDestination('current')
    setBranchName(suggestBranchName(request.source.sourceTitle))
    setBaseRef('')
    void detectAgentSessionContinuationAgents(request.worktreeId)
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
  }, [disabledAgents, open, request, settings?.defaultTuiAgent])

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
    const prompt = buildAgentSessionContinuationPrompt(request.source, contextMode)
    if (!prompt) {
      return
    }
    setStarting(true)
    const launched =
      destination === 'new-worktree' && sourceRepoId
        ? launchAgentSessionContinuationInNewWorktree({
            agent: selectedAgent,
            prompt,
            repoId: sourceRepoId,
            branchName: branchName.trim(),
            baseBranch: baseRef.trim() || null,
            sourceTitle: request.source.sourceTitle,
            telemetrySource:
              request.launchSource === 'sidebar' ? 'sidebar' : 'terminal_context_menu'
          })
        : await launchAgentSessionContinuation({
            agent: selectedAgent,
            prompt,
            worktreeId: request.worktreeId,
            groupId: request.groupId,
            workspacePath: request.workspacePath,
            initialCwd: request.initialCwd,
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
  const creatingWorktree = destination === 'new-worktree'
  const startDisabled =
    detecting ||
    starting ||
    agents.length === 0 ||
    !selectedAgent ||
    (creatingWorktree && !branchName.trim())

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
                <SelectItem value="full" disabled={!hasFullContext}>
                  {translate(
                    'components.agentSessionContinuation.modeFull',
                    'Full session transcript'
                  )}
                </SelectItem>
              </SelectContent>
            </Select>
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

          {canCreateWorktree ? (
            <div className="min-w-0 space-y-1.5">
              <label className="text-xs font-medium">
                {translate('components.agentSessionContinuation.destination', 'Destination')}
              </label>
              <Select
                value={destination}
                onValueChange={(value) => setDestination(value as ContinuationDestination)}
              >
                <SelectTrigger className="min-w-0 w-full" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="current">
                    {translate(
                      'components.agentSessionContinuation.destinationCurrent',
                      'This workspace'
                    )}
                  </SelectItem>
                  <SelectItem value="new-worktree">
                    {translate(
                      'components.agentSessionContinuation.destinationNewWorktree',
                      'New worktree'
                    )}
                  </SelectItem>
                </SelectContent>
              </Select>
              {creatingWorktree ? (
                <div className="min-w-0 space-y-1.5 pt-1">
                  <Input
                    value={branchName}
                    onChange={(event) => setBranchName(event.target.value)}
                    placeholder={translate(
                      'components.agentSessionContinuation.branchNamePlaceholder',
                      'Branch name'
                    )}
                    className="min-w-0 w-full"
                  />
                  <Input
                    value={baseRef}
                    onChange={(event) => setBaseRef(event.target.value)}
                    placeholder={translate(
                      'components.agentSessionContinuation.baseRefPlaceholder',
                      'Base ref (defaults to the project base)'
                    )}
                    className="min-w-0 w-full"
                  />
                  <p className="text-[11px] leading-4 text-muted-foreground">
                    {translate(
                      'components.agentSessionContinuation.destinationNewWorktreeDescription',
                      'Creates the worktree, then starts the Agent there with this context. Uncommitted changes stay in the source workspace.'
                    )}
                  </p>
                </div>
              ) : null}
            </div>
          ) : null}

          {!creatingWorktree && request?.initialCwd ? (
            <div className="text-[11px] text-muted-foreground">
              {translate('components.agentSessionContinuation.startsIn', 'Starts in:')}{' '}
              <span className="break-all font-mono text-foreground/80">{request.initialCwd}</span>
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
