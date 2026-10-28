import React from 'react'
import { toast } from 'sonner'
import { CircleAlert, Info } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { revealTerminalPane } from '@/lib/reveal-terminal-pane'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { WslMoveBlocker } from '../../../../shared/wsl-move/wsl-move-driver-types'
import { wslMoveBlockerHint, wslMoveBlockerTitle } from './wsl-move-copy'
import { wslMoveOrchestratorLine } from './wsl-move-orchestrator-copy'
import {
  useWslMoveOrchestratorStatus,
  wslMoveOrchestratorRecordFor
} from './wsl-move-orchestrator-status'

/** Blockers that name terminal panes, which the user can go to and stop. */
const PANE_BLOCKERS = new Set<WslMoveBlocker['kind']>([
  'agent-working',
  'process-running',
  'agent-not-resumable'
])

/** Opens the busy terminal so the user can stop it there; Orca never ends it for them. */
export function showBlockingTerminal(paneKey: string): void {
  const pane = parsePaneKey(paneKey)
  const { tabsByWorktree } = useAppStore.getState()
  const worktreeId = pane
    ? Object.entries(tabsByWorktree).find(([, tabs]) =>
        tabs.some((tab) => tab.id === pane.tabId)
      )?.[0]
    : undefined
  const shown =
    pane !== null &&
    worktreeId !== undefined &&
    revealTerminalPane({
      worktreeId,
      tabId: pane.tabId,
      leafId: pane.leafId,
      executionHostId: null
    })
  if (!shown) {
    toast(
      translate(
        'wslMove.orchestrator.terminalGone',
        "That terminal isn't open in this window any more. Check again to refresh."
      )
    )
  }
}

function retry(distro: string): void {
  void window.api.wslMove.orchestratorUserAction({ distro, action: 'retry' })
}

/** One line per distro on its host row: why its move waits, and what the user can do. */
export function WslMoveOrchestratorStatusLine({
  distro
}: {
  distro: string
}): React.JSX.Element | null {
  const record = useWslMoveOrchestratorStatus((s) =>
    wslMoveOrchestratorRecordFor(s.records, distro)
  )
  const line = wslMoveOrchestratorLine(record)
  if (!line || !record) {
    return null
  }
  const blockers = record.state.kind === 'deferred' ? record.state.blockers : []
  const paneKey = blockers.find((blocker) => PANE_BLOCKERS.has(blocker.kind))?.ids[0]
  return (
    <div className="flex gap-2 text-xs" data-testid="wsl-move-orchestrator-status">
      {line.kind === 'deferred' ? (
        <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1 space-y-1">
        <div className="text-muted-foreground">{line.text}</div>
        {blockers.map((blocker) => (
          <div key={blocker.kind} className="text-muted-foreground">
            {translate('wslMove.orchestrator.blocker', '{{title}}. {{hint}}', {
              title: wslMoveBlockerTitle(blocker.kind, blocker.ids.length),
              hint: wslMoveBlockerHint(blocker.kind)
            })}
          </div>
        ))}
        <div className="flex gap-1.5">
          {paneKey ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              onClick={() => showBlockingTerminal(paneKey)}
            >
              {translate('wslMove.orchestrator.showTerminal', 'Show terminal')}
            </Button>
          ) : null}
          <Button type="button" size="xs" variant="outline" onClick={() => retry(record.distro)}>
            {line.kind === 'declined'
              ? translate('wslMove.orchestrator.moveAgain', 'Move again')
              : translate('wslMove.orchestrator.checkAgain', 'Check again')}
          </Button>
        </div>
      </div>
    </div>
  )
}
