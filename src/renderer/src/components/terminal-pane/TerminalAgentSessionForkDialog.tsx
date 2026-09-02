import { Copy, GitFork, SquareTerminal } from 'lucide-react'
import { useCallback, useId, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import {
  copyAgentSessionForkContext,
  startAgentSessionFork,
  startAgentSessionForkInSameWorktree,
  type PreparedAgentSessionFork
} from './terminal-agent-session-fork'
import { filterEnabledTuiAgents } from '../../../../shared/tui-agent-selection'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

type TerminalAgentSessionForkDialogProps = {
  open: boolean
  fork: PreparedAgentSessionFork | null
  onOpenChange: (open: boolean) => void
}

type PendingForkAction = 'copy' | 'same-worktree' | 'new-worktree'

export function TerminalAgentSessionForkDialog({
  open,
  fork,
  onOpenChange
}: TerminalAgentSessionForkDialogProps): React.JSX.Element {
  const [pending, setPending] = useState<PendingForkAction | null>(null)
  const pendingRef = useRef(false)
  const [selectedAgent, setSelectedAgent] = useState<TuiAgent | null>(fork?.agent ?? null)
  const agentPickerLabelId = useId()
  const disabledTuiAgents = useAppStore((s) => s.settings?.disabledTuiAgents ?? [])
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  // Why: the picker must list agents installed on the host the fork runs on —
  // local, or the SSH connection that owns the source worktree.
  const forkConnectionId = useAppStore((s) => {
    const worktree = fork ? s.getKnownWorktreeById(fork.worktreeId) : undefined
    if (!worktree) {
      return null
    }
    return s.repos?.find((repo) => repo.id === worktree.repoId)?.connectionId ?? null
  })
  const { detectedIds } = useDetectedAgents(fork ? forkConnectionId : undefined)
  const busy = pending !== null

  // Why: reset the picker default to the source agent each time a new fork is
  // prepared (so the dialog opens with "whatever the first terminal is using"),
  // adjusting during render on identity change instead of via a derived effect.
  const lastForkRef = useRef(fork)
  if (lastForkRef.current !== fork) {
    lastForkRef.current = fork
    setSelectedAgent(fork?.agent ?? null)
  }

  const agents = useMemo(() => {
    const catalog = getAgentCatalog()
    const enabledIds = new Set(
      filterEnabledTuiAgents(
        catalog.map((agent) => agent.id),
        disabledTuiAgents
      )
    )
    // Why: show only enabled agents that are actually detected on the host —
    // matching the Create-worktree picker. `null` = detection in flight, so fall
    // back to all enabled until it resolves.
    const detectedSet = detectedIds ? new Set(detectedIds) : null
    const list = catalog.filter(
      (agent) => enabledIds.has(agent.id) && (detectedSet === null || detectedSet.has(agent.id))
    )
    // Why: keep the source agent selectable as the default even if it is not in
    // the detected/enabled set.
    if (fork?.agent && !list.some((agent) => agent.id === fork.agent)) {
      const sourceEntry = catalog.find((agent) => agent.id === fork.agent)
      if (sourceEntry) {
        list.unshift(sourceEntry)
      }
    }
    return list
  }, [disabledTuiAgents, detectedIds, fork?.agent])

  // Why: mirror the Create-worktree picker's "Manage agents" footer, navigating
  // to Settings → Agents and dismissing the fork dialog.
  const handleOpenManageAgents = useCallback(() => {
    openSettingsTarget({ pane: 'agents', repoId: null })
    openSettingsPage()
    onOpenChange(false)
  }, [openSettingsPage, openSettingsTarget, onOpenChange])

  const runForkAction = async (
    action: PendingForkAction,
    run: (fork: PreparedAgentSessionFork) => Promise<boolean>
  ): Promise<void> => {
    if (!fork || pendingRef.current) {
      return
    }
    pendingRef.current = true
    setPending(action)
    try {
      if (await run(fork)) {
        onOpenChange(false)
      }
    } finally {
      pendingRef.current = false
      setPending(null)
    }
  }

  const handleCopyContext = (): Promise<void> =>
    runForkAction('copy', (f) => copyAgentSessionForkContext(f))

  const handleForkInWorktree = (): Promise<void> =>
    runForkAction('same-worktree', (f) =>
      startAgentSessionForkInSameWorktree(f, { agent: selectedAgent })
    )

  const handleStartFork = (): Promise<void> =>
    runForkAction('new-worktree', (f) => startAgentSessionFork(f, { agent: selectedAgent }))

  const handleOpenChange = (nextOpen: boolean): void => {
    if (pendingRef.current && !nextOpen) {
      return
    }
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-4 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base">
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.64e292e8e3',
              'Fork Agent Session'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.0f91a549fe',
              "Start a fresh agent with this session's context."
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/20 px-3 py-3">
          <GitFork className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 text-xs text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.c730579670',
              'The new agent receives a bounded transcript as an editable draft.'
            )}
          </p>
        </div>

        <div className="space-y-1.5">
          <p id={agentPickerLabelId} className="text-xs font-medium text-muted-foreground">
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.3d187cd60d',
              'Agent'
            )}
          </p>
          <AgentCombobox
            agents={agents}
            value={selectedAgent}
            onValueChange={setSelectedAgent}
            onOpenManageAgents={handleOpenManageAgents}
            triggerAriaLabelledBy={agentPickerLabelId}
            triggerClassName="w-full"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => void handleCopyContext()}>
            <Copy className="size-4" />
            {translate(
              'auto.components.terminal.pane.TerminalAgentSessionForkDialog.17fc841e59',
              'Copy context'
            )}
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void handleForkInWorktree()}>
            <SquareTerminal className="size-4" />
            {pending === 'same-worktree'
              ? translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.c040642db4',
                  'Opening...'
                )
              : translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.4256baaae3',
                  'Fork in this worktree'
                )}
          </Button>
          <Button disabled={busy} onClick={() => void handleStartFork()}>
            <GitFork className="size-4" />
            {pending === 'new-worktree'
              ? translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.2b10412cfc',
                  'Creating...'
                )
              : translate(
                  'auto.components.terminal.pane.TerminalAgentSessionForkDialog.9d25de2920',
                  'Create fork'
                )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
