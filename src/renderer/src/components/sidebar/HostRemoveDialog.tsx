import React, { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { removeSshTargetWithBestEffortCleanup } from '../settings/ssh-target-remove'
import { clearHostRename } from './host-rename-remove'
import type { HostRemovalTarget } from './host-rename-remove'

type HostRemoveDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  hostId: ExecutionHostId
  label: string
  target: NonNullable<HostRemovalTarget>
}

export function HostRemoveDialog({
  open,
  onOpenChange,
  hostId,
  label,
  target
}: HostRemoveDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const mountedRef = useMountedRef()

  // Why: dropping a host should also drop its now-orphaned label override so a
  // future host reusing the same id doesn't inherit a stale rename.
  const dropOverridesForHost = (): void => {
    const state = useAppStore.getState()
    void state.updateSettings({
      hostSettingOverrides: clearHostRename(state.settings, hostId)
    })
  }

  const handleRemoveSsh = async (targetId: string): Promise<void> => {
    await removeSshTargetWithBestEffortCleanup(window.api.ssh, targetId)
    // Why: clear deferred reconnect metadata so focused SSH tabs stop retrying
    // the deleted target — mirrors the SSH settings pane removal flow.
    useAppStore.getState().clearRemovedSshTargetState(targetId)
    dropOverridesForHost()
  }

  // Why: runtime-environment removal needs active-environment switching and
  // error context owned by the Orca servers settings pane, so we deep-link
  // there with the host pre-selected instead of duplicating that flow.
  const handleRemoveRuntime = (environmentId: string): void => {
    const state = useAppStore.getState()
    state.openSettingsTarget({ pane: 'servers', repoId: null, sectionId: environmentId })
    state.openSettingsPage()
    onOpenChange(false)
  }

  const confirm = async (): Promise<void> => {
    if (target.kind === 'runtime') {
      handleRemoveRuntime(target.environmentId)
      return
    }
    setBusy(true)
    try {
      await handleRemoveSsh(target.targetId)
      if (mountedRef.current) {
        onOpenChange(false)
      }
      toast.success(
        translate('auto.components.sidebar.HostRemoveDialog.1a2b3c4d5e', 'Removed {{value0}}', {
          value0: label
        })
      )
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate(
              'auto.components.sidebar.HostRemoveDialog.2b3c4d5e6f',
              'Failed to remove host'
            )
      )
    } finally {
      if (mountedRef.current) {
        setBusy(false)
      }
    }
  }

  const isRuntime = parseExecutionHostId(hostId)?.kind === 'runtime'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.sidebar.HostRemoveDialog.3c4d5e6f7a',
              'Remove {{value0}}?',
              {
                value0: label
              }
            )}
          </DialogTitle>
          <DialogDescription>
            {isRuntime
              ? translate(
                  'auto.components.sidebar.HostRemoveDialog.4d5e6f7a8b',
                  'This opens the Orca servers settings where you can remove this server.'
                )
              : translate(
                  'auto.components.sidebar.HostRemoveDialog.5e6f7a8b9c',
                  'This removes the saved SSH host and its credentials from this computer. Remote files are not deleted.'
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.sidebar.HostRemoveDialog.6f7a8b9c0d', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {isRuntime
              ? translate('auto.components.sidebar.HostRemoveDialog.7a8b9c0d1e', 'Open settings')
              : translate('auto.components.sidebar.HostRemoveDialog.8b9c0d1e2f', 'Remove host')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
