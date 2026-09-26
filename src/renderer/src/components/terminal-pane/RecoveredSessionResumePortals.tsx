import { useState } from 'react'
import {
  recoveryBindingKeyOf,
  type RecoveryBindingKey
} from '../../../../shared/cross-machine-recovery-binding-key'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { releaseDormantRecoveryPaneToShell } from '@/lib/dormant-recovery-shell-release'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { useAppStore } from '@/store'
import { isDormantRecoveryRecord } from '../../../../shared/agent-session-resume'
import { makePaneKey } from '../../../../shared/stable-pane-id'

type RecoveredSessionResumeButtonProps = {
  worktreeId: string
  binding: RecoveryBindingKey
  paneKey: string
}

export function RecoveredSessionResumeButton({
  worktreeId,
  binding,
  paneKey
}: RecoveredSessionResumeButtonProps): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const resume = (): void => {
    setPending(true)
    window.api.crossMachineRecovery
      .resumeLocal({ worktreeId, binding })
      .catch(() => {
        toast.error(
          translate('crossMachineRecovery.resumeFailed', "Couldn't resume the recovered session")
        )
      })
      .finally(() => setPending(false))
  }
  const startShell = (): void => {
    setPending(true)
    window.api.crossMachineRecovery
      .releaseLocal({ worktreeId, binding })
      .then(({ released }) => {
        releaseDormantRecoveryPaneToShell(paneKey)
        toast.info(
          translate(
            'crossMachineRecovery.shellStarted',
            'Started a shell; released recovered {{agent}} session {{session}}',
            { agent: released.agent, session: released.id }
          )
        )
      })
      .catch(() => {
        toast.error(
          translate(
            'crossMachineRecovery.startShellFailed',
            "Couldn't start a shell for the recovered session"
          )
        )
      })
      .finally(() => setPending(false))
  }
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-2"
      data-testid="recovered-session-placeholder"
      data-pane-key={paneKey}
    >
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-xs">
        <span className="text-xs text-muted-foreground">
          {translate('crossMachineRecovery.recoveredSession', 'Recovered session')}
        </span>
        <Button type="button" size="sm" disabled={pending} onClick={resume}>
          {translate('crossMachineRecovery.resume', 'Resume')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={pending} onClick={startShell}>
          {translate('crossMachineRecovery.startShellInstead', 'Start shell instead')}
        </Button>
      </div>
    </div>
  )
}

type RecoveredSessionResumePortalsProps = {
  panes: readonly Pick<ManagedPane, 'id' | 'container' | 'leafId'>[]
  tabId: string
  worktreeId: string
}

/** Dormant imported sessions never launch on their own; the pane offers Resume or a plain shell. */
export function RecoveredSessionResumePortals({
  panes,
  tabId,
  worktreeId
}: RecoveredSessionResumePortalsProps): React.JSX.Element {
  const records = useAppStore((s) => s.sleepingAgentSessionsByPaneKey)
  return (
    <>
      {panes.map((pane) => {
        const paneKey = makePaneKey(tabId, pane.leafId)
        const record = records[paneKey]
        if (!record || !isDormantRecoveryRecord(record)) {
          return null
        }
        return createPortal(
          <RecoveredSessionResumeButton
            worktreeId={worktreeId}
            binding={recoveryBindingKeyOf(record)}
            paneKey={paneKey}
          />,
          pane.container,
          `recovered-session-resume-${pane.id}`
        )
      })}
    </>
  )
}
