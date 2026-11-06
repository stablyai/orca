import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { activateStructuredAgentSessionById } from '../../lib/agent-session/structured-agent-session-tab-activation'
import { activateAndRevealWorkspace } from '../../lib/worktree-activation'
import { activateTabAndFocusPane } from '../../lib/activate-tab-and-focus-pane'
import { useAppStore } from '../../store'
import { getRepositorySourceControlAiSectionId } from '../settings/repository/repository-settings-targets'
import { useState } from 'react'
import type { FollowUpView } from '../../../../shared/pr-follow-ups/contracts'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import { usePrFollowUpWorkspace, usePrFollowUpFixing } from './follow-up-resource'

function stateText(view: FollowUpView): string {
  if (view.stopped) {
    return 'Stopped for this PR'
  }
  switch (view.state) {
    case 'off':
      return view.offReason === 'nothing'
        ? 'Off · Checks fail is set to Nothing'
        : view.offReason === 'branch'
          ? 'Off · This branch doesn’t match the PR'
          : 'Off · Automatic follow-ups are switched off'
    case 'armed':
      return 'Armed for new failing checks'
    case 'waiting':
      return `Waiting for ${view.workingAgent} in this workspace to finish`
    case 'waiting-window':
      return `Waiting for the Orca window to start ${view.workingAgent}`
    case 'handled':
      return 'Handled for this commit'
    case 'paused':
      if (view.pauseReason === 'generation') {
        return `Auto follow-ups paused (${view.used} of ${view.limit} used). A new push from you resets it once no automatic agent is still working there`
      }
      if (view.pauseReason === 'daily') {
        return `Auto follow-ups paused (6 in 24 h). Resumes at ${new Date(view.resumesAt!).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`
      }
      return 'Paused'
    case 'baseline':
      return 'Already failing when follow-ups were turned on'
    case 'starting':
      return `Starting ${formatAgentTypeLabel(view.workingAgent)}…`
    case 'unconfirmed':
      return 'Couldn’t confirm the agent started'
    case 'prompt-unconfirmed':
      return 'Agent started; couldn’t confirm it received the prompt'
  }
}

export function PrFollowUpRow({
  worktreeId,
  repo,
  onFixChecks
}: {
  worktreeId: string
  repo: Repo | null
  onFixChecks(): void
}): React.JSX.Element | null {
  const current = usePrFollowUpWorkspace(worktreeId)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!current) {
    return null
  }
  const { view } = current
  const canResume =
    view.stopped ||
    (view.state === 'paused' && (view.pauseReason === 'reads' || view.pauseReason === 'comments'))
  const openWorkspace = (): void => {
    activateAndRevealWorkspace(view.action?.worktreeId ?? worktreeId)
  }
  const openAgent = (): void => {
    openWorkspace()
    if (view.action?.sessionId) {
      activateStructuredAgentSessionById({
        worktreeId: view.action.worktreeId,
        sessionId: view.action.sessionId
      })
    }
    const pane = view.action?.paneKey ? parsePaneKey(view.action.paneKey) : null
    if (pane) {
      activateTabAndFocusPane(pane.tabId, pane.leafId)
    }
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0 font-medium">Automatic follow-ups</span>
      <span className="min-w-0 truncate" title={stateText(view)}>
        {stateText(view)}
        {view.state !== 'paused' && ` · ${view.used}/${view.limit}`}
      </span>
      {view.state === 'off' && !view.stopped && repo && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            useAppStore.getState().openSettingsTarget({
              pane: 'repo',
              repoId: repo.id,
              hostId: getRepoExecutionHostId(repo),
              sectionId: getRepositorySourceControlAiSectionId(repo.id)
            })
          }
        >
          Project settings
        </Button>
      )}
      {view.state === 'prompt-unconfirmed' && (
        <Button variant="ghost" size="sm" onClick={openAgent}>
          Open agent
        </Button>
      )}
      {view.state === 'unconfirmed' && (
        <Button variant="ghost" size="sm" onClick={openWorkspace}>
          Open workspace
        </Button>
      )}
      {view.state === 'baseline' && (
        <Button variant="ghost" size="sm" onClick={onFixChecks}>
          Fix with AI
        </Button>
      )}
      {(view.state !== 'off' || view.stopped) && (
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => {
            setSaving(true)
            setError(null)
            void callRuntimeRpc({ kind: 'local' }, 'prFollowUps.stop', {
              worktreeId,
              stopped: !canResume
            })
              .catch(() => setError('Could not update follow-ups. Try again.'))
              .finally(() => setSaving(false))
          }}
        >
          {canResume ? 'Resume' : 'Stop for this PR'}
        </Button>
      )}
      {error && (
        <span role="alert" className="text-destructive">
          {error}
        </span>
      )}
    </div>
  )
}

export function PrFollowUpBadge({ worktreeId }: { worktreeId: string }): React.JSX.Element | null {
  const fixing = usePrFollowUpFixing(worktreeId)
  return fixing ? (
    <Badge variant="outline" className="h-4 shrink-0 px-1.5 text-[9px] text-primary">
      Fixing checks · auto
    </Badge>
  ) : null
}
