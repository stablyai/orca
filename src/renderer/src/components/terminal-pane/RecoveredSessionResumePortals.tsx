import { useState } from 'react'
import { createPortal } from 'react-dom'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'
import { useAppStore } from '@/store'
import { isCrossMachineRecoveryRecord } from '../../../../shared/cross-machine-recovery-session-ops'
import { makePaneKey } from '../../../../shared/stable-pane-id'

type RecoveredSessionResumeButtonProps = {
  worktreeId: string
  providerSessionId: string
}

export function RecoveredSessionResumeButton({
  worktreeId,
  providerSessionId
}: RecoveredSessionResumeButtonProps): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const resume = (): void => {
    setPending(true)
    window.api.crossMachineRecovery
      .resumeLocal({ worktreeId, providerSessionId })
      .catch(() => {
        toast.error(
          translate('crossMachineRecovery.resumeFailed', "Couldn't resume the recovered session")
        )
      })
      .finally(() => setPending(false))
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-40 flex justify-center p-2">
      <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-card-foreground shadow-xs">
        <span className="text-xs text-muted-foreground">
          {translate('crossMachineRecovery.recoveredSession', 'Recovered session')}
        </span>
        <Button type="button" size="sm" disabled={pending} onClick={resume}>
          {translate('crossMachineRecovery.resume', 'Resume')}
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

/** Dormant imported sessions never launch on their own; the pane offers an explicit Resume. */
export function RecoveredSessionResumePortals({
  panes,
  tabId,
  worktreeId
}: RecoveredSessionResumePortalsProps): React.JSX.Element {
  const records = useAppStore((s) => s.sleepingAgentSessionsByPaneKey)
  return (
    <>
      {panes.map((pane) => {
        const record = records[makePaneKey(tabId, pane.leafId)]
        if (!record || !isCrossMachineRecoveryRecord(record)) {
          return null
        }
        return createPortal(
          <RecoveredSessionResumeButton
            worktreeId={worktreeId}
            providerSessionId={record.providerSession.id}
          />,
          pane.container,
          `recovered-session-resume-${pane.id}`
        )
      })}
    </>
  )
}
