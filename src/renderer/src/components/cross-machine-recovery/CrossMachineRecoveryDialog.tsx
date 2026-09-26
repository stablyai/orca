import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandList
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { translate } from '@/i18n/i18n'
import type { CcSyncProgress } from '../../../../shared/cross-machine-recovery-provider-types'
import {
  consumeCrossMachineRecoveryDialogRequest,
  getCrossMachineRecoveryDialogRequest,
  subscribeCrossMachineRecoveryDialog
} from './cross-machine-recovery-dialog-request'
import {
  refreshCrossMachineRecovery,
  useCrossMachineRecoverySnapshot
} from './cross-machine-recovery-provider-store'
import { buildRecoverySourceGroups } from './cross-machine-recovery-rows'
import { pickupPhaseLabel, providerErrorMessage } from './cross-machine-recovery-copy'
import {
  revealRecoveredWorktree,
  startRecoveryPickup,
  type RecoveryPickupHandle
} from './cross-machine-recovery-pickup'
import {
  CrossMachineRecoveryItemRow,
  CrossMachineRecoverySessionRow
} from './CrossMachineRecoveryItemRow'

export function CrossMachineRecoveryDialog(): React.JSX.Element | null {
  const open = useSyncExternalStore(
    subscribeCrossMachineRecoveryDialog,
    getCrossMachineRecoveryDialogRequest,
    getCrossMachineRecoveryDialogRequest
  )
  const snapshot = useCrossMachineRecoverySnapshot()
  const [selector, setSelector] = useState<string | null>(null)
  /** The user's ticks over each session's default, so a refreshed list never needs re-seeding. */
  const [overrides, setOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [pickup, setPickup] = useState<RecoveryPickupHandle | null>(null)
  const [progress, setProgress] = useState<CcSyncProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (open) {
      setNow(Date.now())
      void refreshCrossMachineRecovery()
    }
  }, [open])

  const list = snapshot.list
  const groups = useMemo(
    () => (list?.ok ? buildRecoverySourceGroups(list.value.items) : []),
    [list]
  )
  const selected = useMemo(
    () =>
      groups.flatMap((group) => group.workspaces).find((row) => row.selector === selector) ?? null,
    [groups, selector]
  )
  const resume = useMemo(
    () =>
      (selected?.sessions ?? [])
        .filter(
          (session) =>
            !session.liveLocalCollision &&
            (overrides.get(session.sessionId) ??
              session.sessionId === selected?.defaultResumeSessionId)
        )
        .map((session) => session.sessionId),
    [selected, overrides]
  )
  // Why: the provider reports this computer's own name; the window's runtime host never matters here.
  const machineName = list?.ok
    ? list.value.local.host_name
    : snapshot.status?.ok
      ? snapshot.status.value.local.host_name
      : null

  const close = useCallback(() => {
    consumeCrossMachineRecoveryDialogRequest()
    setSelector(null)
    setOverrides(new Map())
    setError(null)
  }, [])

  const toggleResume = useCallback((sessionId: string, checked: boolean) => {
    setOverrides((current) => new Map(current).set(sessionId, checked))
  }, [])

  const recover = useCallback(async () => {
    if (!selected) {
      return
    }
    setError(null)
    const handle = startRecoveryPickup({
      selector: selected.selector,
      resume,
      onProgress: setProgress
    })
    setPickup(handle)
    const result = await handle.result
    setPickup(null)
    setProgress(null)
    if (!result.ok) {
      setError(providerErrorMessage(result.error))
      return
    }
    if (result.value.orca) {
      await revealRecoveredWorktree(result.value.orca.worktree_id)
    }
    close()
    void refreshCrossMachineRecovery()
  }, [selected, resume, close])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pickup) {
          close()
        }
      }}
    >
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto_auto] sm:max-w-xl max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>
            <span className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" />
              {translate(
                'components.cross-machine-recovery.dialog.title',
                'Recover work from another computer'
              )}
            </span>
          </DialogTitle>
          <DialogDescription data-testid="cross-machine-recovery-destination">
            {machineName
              ? translate(
                  'components.cross-machine-recovery.dialog.destinationNamed',
                  'Recovers to this computer ({{machineName}})',
                  {
                    machineName
                  }
                )
              : translate(
                  'components.cross-machine-recovery.dialog.destination',
                  'Recovers to this computer'
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 rounded-md border">
          <Command className="min-h-0">
            <CommandInput
              placeholder={translate(
                'components.cross-machine-recovery.dialog.filter',
                'Filter workspaces and sessions'
              )}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>
                {list && !list.ok
                  ? providerErrorMessage(list.error)
                  : snapshot.loading
                    ? translate(
                        'components.cross-machine-recovery.dialog.loading',
                        'Looking for recoverable work…'
                      )
                    : translate(
                        'components.cross-machine-recovery.dialog.empty',
                        'No work from other computers yet.'
                      )}
              </CommandEmpty>
              {groups.map((group) => (
                <CommandGroup
                  key={group.hostId}
                  heading={
                    group.reachable
                      ? group.hostName
                      : translate(
                          'components.cross-machine-recovery.dialog.unreachable',
                          '{{hostName}} (unreachable)',
                          {
                            hostName: group.hostName
                          }
                        )
                  }
                >
                  {group.workspaces.map((row) => (
                    <CrossMachineRecoveryItemRow
                      key={row.selector}
                      row={row}
                      hostName={group.hostName}
                      now={now}
                      onSelect={setSelector}
                    />
                  ))}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </div>
        {selected ? (
          <div className="rounded-md border bg-muted/35 p-1.5">
            <ScrollArea className="max-h-48">
              {selected.sessions.map((session) => (
                <CrossMachineRecoverySessionRow
                  key={session.sessionId}
                  session={session}
                  checked={resume.includes(session.sessionId)}
                  now={now}
                  onCheckedChange={toggleResume}
                />
              ))}
            </ScrollArea>
          </div>
        ) : null}
        {error || progress ? (
          <p className="text-xs text-muted-foreground" role={error ? 'alert' : 'status'}>
            {error ?? (progress ? pickupPhaseLabel(progress) : null)}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => (pickup ? void pickup.cancel() : close())}
          >
            {translate('components.cross-machine-recovery.dialog.cancel', 'Cancel')}
          </Button>
          <Button size="sm" disabled={!selected || pickup !== null} onClick={() => void recover()}>
            {translate('components.cross-machine-recovery.dialog.recover', 'Recover')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
