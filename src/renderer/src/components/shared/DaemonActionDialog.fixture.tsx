import { defineFixture } from '../../component-fixtures/component-fixture'
import { useEffect } from 'react'
import { toast } from 'sonner'
import { Toaster } from '../ui/sonner'
import {
  DaemonActionDialog,
  useDaemonActions,
  type DaemonActionKind,
  type DaemonActionsApi
} from './useDaemonActions'

function IncompleteCleanupResult(): React.JSX.Element {
  const { runKillAll } = useDaemonActions()
  useEffect(() => {
    void runKillAll()
  }, [runKillAll])
  return <Toaster />
}

export const incompleteInventory = defineFixture({
  width: 640,
  setup: () => {
    toast.dismiss()
    Object.assign(window.api.pty.management, {
      killAll: () => Promise.resolve({ killedCount: 0, remainingCount: 0, listingIncomplete: true })
    })
  },
  render: () => (
    <div className="h-[400px] bg-background">
      <IncompleteCleanupResult />
    </div>
  )
})

function api(
  pending: DaemonActionKind,
  state: { busy?: boolean; error?: string } = {}
): DaemonActionsApi {
  const never = (): Promise<void> => new Promise(() => {})
  return {
    pending,
    setPending: () => {},
    busyKind: state.busy ? pending : null,
    isBusy: state.busy === true,
    error: state.error ?? null,
    runRestart: never,
    runKillAll: never,
    runConfirmed: () => {}
  }
}

function dialogFixture(daemonApi: DaemonActionsApi) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="h-[320px] bg-background">
        <DaemonActionDialog api={daemonApi} />
      </div>
    )
  })
}

export const killAll = dialogFixture(api('killAll'))

export const killAllBusy = dialogFixture(api('killAll', { busy: true }))

export const restart = dialogFixture(api('restart'))

export const restartBusy = dialogFixture(api('restart', { busy: true }))

export const restartError = dialogFixture(
  api('restart', { error: 'Couldn’t restart the terminal service.' })
)
