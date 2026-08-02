import React, { useMemo, useState } from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
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
import { getAllWorktreesFromState } from '@/store/selectors'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { removeSshTargetWithBestEffortCleanup } from '../settings/ssh-target-remove'
import { clearHostRename } from './host-rename-remove'
import type { HostRemovalTarget } from './host-rename-remove'
import { resolveSshHostRemoval } from './ssh-host-remove-resolution'
import { clearSshHostWorkspaces } from './ssh-host-remove-workspaces'

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
  // Why: removing the host only (keeping workspaces) is the safe, reversible
  // default. Deleting the remote workspaces is destructive, so it lives behind
  // an Advanced disclosure and must be opted into explicitly.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [deleteWorkspaces, setDeleteWorkspaces] = useState(false)
  const mountedRef = useMountedRef()

  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const sshConnectionStates = useAppStore((s) => s.sshConnectionStates)

  // Resolve which workspaces live on the target so the dialog can offer to
  // delete/forget them alongside the host.
  const sshResolution = useMemo(() => {
    if (target.kind !== 'ssh') {
      return null
    }
    return resolveSshHostRemoval({
      targetId: target.targetId,
      repos,
      worktrees: getAllWorktreesFromState({ worktreesByRepo }),
      sshConnectionStates
    })
  }, [target, repos, worktreesByRepo, sshConnectionStates])

  const workspaceCount = sshResolution?.workspaceCount ?? 0
  const hasWorkspaces = workspaceCount > 0
  const isConnected = sshResolution?.isConnected ?? false

  // Why: dropping a host should also drop its now-orphaned label override so a
  // future host reusing the same id doesn't inherit a stale rename.
  const dropOverridesForHost = (): void => {
    const state = useAppStore.getState()
    void state.updateSettings({
      hostSettingOverrides: clearHostRename(state.settings, hostId)
    })
  }

  const removeSshTarget = async (targetId: string): Promise<void> => {
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

  const runSshRemoval = async (): Promise<void> => {
    if (target.kind !== 'ssh') {
      return
    }
    setBusy(true)
    try {
      if (deleteWorkspaces && sshResolution) {
        // Connected → real remote removal; offline/ghost → local forget.
        const { failedIds } = await clearSshHostWorkspaces(
          sshResolution,
          isConnected ? 'delete-remote' : 'forget-local'
        )
        // Why: don't remove the SSH target (and report success) while some of its
        // workspaces failed to clear — that would strand ghost rows behind a
        // now-gone host. Surface the failure and keep the target so the user can
        // retry or resolve the blocking workspace first.
        if (failedIds.length > 0) {
          if (mountedRef.current) {
            setBusy(false)
          }
          toast.error(
            translate(
              'auto.components.sidebar.HostRemoveDialog.workspacesFailed',
              'Could not remove {{count}} of this host’s workspaces. The host was kept so you can retry.',
              { count: failedIds.length }
            )
          )
          return
        }
      }
      await removeSshTarget(target.targetId)
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

  const workspaceCountLabel =
    workspaceCount === 1
      ? translate('auto.components.sidebar.HostRemoveDialog.oneWorkspace', '1 workspace')
      : translate(
          'auto.components.sidebar.HostRemoveDialog.manyWorkspaces',
          '{{count}} workspaces',
          {
            count: workspaceCount
          }
        )

  const description =
    target.kind === 'runtime'
      ? translate(
          'auto.components.sidebar.HostRemoveDialog.4d5e6f7a8b',
          'This opens the Orca servers settings where you can remove this server.'
        )
      : hasWorkspaces
        ? translate(
            'auto.components.sidebar.HostRemoveDialog.hostHasWorkspacesDefault',
            'Removes {{value0}} and its credentials from this computer. Its {{value1}} stay in Orca — remote files are not touched.',
            { value0: label, value1: workspaceCountLabel }
          )
        : translate(
            'auto.components.sidebar.HostRemoveDialog.5e6f7a8b9c',
            'This removes the saved SSH host and its credentials from this computer. Remote files are not deleted.'
          )

  // The destructive opt-in wording depends on whether we delete remote files or
  // only forget Orca's records (offline/ghost host).
  const deleteOptionLabel = isConnected
    ? translate(
        'auto.components.sidebar.HostRemoveDialog.alsoDeleteRemote',
        'Also delete these {{value0}} on {{value1}}',
        { value0: workspaceCountLabel, value1: label }
      )
    : translate(
        'auto.components.sidebar.HostRemoveDialog.alsoForgetLocal',
        'Also remove these {{value0}} from Orca',
        { value0: workspaceCountLabel }
      )

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
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Advanced disclosure: deleting the host's workspaces is destructive, so
            it's opt-in and hidden by default. Only shown when there are any.
            Matches the New Workspace composer's Advanced header + switch. */}
        {target.kind === 'ssh' && hasWorkspaces ? (
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="-ml-2 text-xs"
            >
              {translate('auto.components.sidebar.HostRemoveDialog.advanced', 'Advanced')}
              <ChevronDown
                className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
              />
            </Button>
            <div
              className={cn(
                'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
                advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
              )}
              aria-hidden={!advancedOpen}
            >
              <div className="min-h-0">
                <div className="flex items-start gap-3 px-1 pt-1">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={deleteWorkspaces}
                    onClick={() => setDeleteWorkspaces((v) => !v)}
                    className="group mt-0.5 flex shrink-0 cursor-pointer items-center rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors',
                        deleteWorkspaces ? 'bg-foreground' : 'bg-muted-foreground/30'
                      )}
                    >
                      <span
                        className={cn(
                          'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
                          deleteWorkspaces ? 'translate-x-4' : 'translate-x-0.5'
                        )}
                      />
                    </span>
                  </button>
                  <span className="min-w-0 flex-1 text-xs leading-snug">
                    <span className="font-medium text-foreground">{deleteOptionLabel}</span>
                    <span className="mt-0.5 block text-muted-foreground">
                      {isConnected
                        ? translate(
                            'auto.components.sidebar.HostRemoveDialog.alsoDeleteRemoteHint',
                            'Permanently deletes the remote Git worktrees and their branches. Cannot be undone.'
                          )
                        : translate(
                            'auto.components.sidebar.HostRemoveDialog.alsoForgetLocalHint',
                            'Clears them from Orca only. Remote files, worktrees, and branches are left untouched.'
                          )}
                    </span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {translate('auto.components.sidebar.HostRemoveDialog.6f7a8b9c0d', 'Cancel')}
          </Button>
          {target.kind === 'runtime' ? (
            <Button
              type="button"
              variant="destructive"
              onClick={() => handleRemoveRuntime(target.environmentId)}
            >
              {translate('auto.components.sidebar.HostRemoveDialog.7a8b9c0d1e', 'Open settings')}
            </Button>
          ) : (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void runSshRemoval()}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {translate('auto.components.sidebar.HostRemoveDialog.8b9c0d1e2f', 'Remove host')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
