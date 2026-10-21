import React from 'react'
import { Archive, Moon, Trash2, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { MachineMatch } from '@/lib/machines/machine-host-match'
import { getMachineMenuActions } from '@/lib/machines/machine-actions'
import { wakeStoppedMachine } from '@/lib/machines/machine-wake-on-open'
import { getStoppedMachineTitle } from '@/lib/machines/machine-copy'

/**
 * A terminal whose machine sleeps, is archived or is gone: nothing will reconnect on its own, so
 * the pane says why and offers Wake where waking can help, instead of a reconnect that can't.
 * `unreachable` covers a running machine whose server the transport couldn't reach. Wake is the
 * same wake opening the worktree runs, so the terminal holds its attach and names the outcome.
 */
export function StoppedMachineBanner({
  match,
  worktreeId,
  unreachable = false
}: {
  match: MachineMatch
  worktreeId?: string
  unreachable?: boolean
}): React.JSX.Element {
  const archived = match.machine.state === 'archived'
  const gone = match.machine.state === 'gone'
  const canWake = getMachineMenuActions(match).includes('wake')
  if (unreachable) {
    return (
      <MachineBannerFrame
        state="unreachable"
        icon={<Unplug className="size-4" />}
        title={translate(
          'auto.components.machines.StoppedMachineBanner.unreachable',
          'Can’t reach {{name}}',
          { name: match.machine.name }
        )}
        body={translate(
          'auto.components.machines.StoppedMachineBanner.unreachableBody',
          'It may still be starting. If this stays, sleep and wake it from its menu.'
        )}
      />
    )
  }
  return (
    <MachineBannerFrame
      state={match.machine.state}
      icon={
        gone ? (
          <Trash2 className="size-4" />
        ) : archived ? (
          <Archive className="size-4" />
        ) : (
          <Moon className="size-4" />
        )
      }
      title={getStoppedMachineTitle(match)}
      body={
        gone
          ? translate(
              'auto.components.machines.StoppedMachineBanner.goneBody',
              'This terminal can’t resume. Remove the worktree from its menu when you’re done.'
            )
          : canWake
            ? translate(
                'auto.components.machines.StoppedMachineBanner.body',
                'Wake it to resume this terminal.'
              )
            : translate(
                'auto.components.machines.StoppedMachineBanner.reopenBody',
                'This terminal resumes when the machine wakes.'
              )
      }
      action={
        canWake ? (
          <Button size="sm" onClick={() => void wakeStoppedMachine(match, worktreeId)}>
            {translate('auto.components.machines.StoppedMachineBanner.wake', 'Wake machine')}
          </Button>
        ) : null
      }
    />
  )
}

function MachineBannerFrame({
  state,
  icon,
  title,
  body,
  action = null
}: {
  state: string
  icon: React.ReactNode
  title: string
  body: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className="pointer-events-none absolute inset-x-3 bottom-3 z-30 flex justify-center"
      data-terminal-stopped-machine-banner={state}
    >
      <div
        className="pointer-events-auto flex w-full max-w-xl items-center gap-3 rounded-md border border-border bg-card/95 px-3 py-3 text-card-foreground shadow-xs backdrop-blur-[1px]"
        role="status"
        aria-live="polite"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">{title}</div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{body}</div>
        </div>
        {action}
      </div>
    </div>
  )
}
