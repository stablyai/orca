/**
 * The general migration's per-distro state (D3a-2), as main publishes it. Read only while WSL
 * hosts are on in this window: with them off nothing subscribes and no IPC is made. A toast
 * marks a live change to done or parked, never a state that was already there on load.
 */
import { create } from 'zustand'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { WslMoveOrchestratorRecord } from '../../../../shared/wsl-move/wsl-move-orchestrator-types'
import { wslMoveOrchestratorParkedToast } from './wsl-move-orchestrator-copy'

type StatusState = { records: Record<string, WslMoveOrchestratorRecord> }

export const useWslMoveOrchestratorStatus = create<StatusState>(() => ({ records: {} }))

/**
 * WSL compares distro names case-insensitively. Not the journal key from wsl-move-cutover: that
 * module pulls node-only code into the renderer bundle.
 */
export function wslMoveOrchestratorDistroKey(distro: string): string {
  return distro.trim().toLowerCase()
}

export function wslMoveOrchestratorRecordFor(
  records: Record<string, WslMoveOrchestratorRecord>,
  distro: string
): WslMoveOrchestratorRecord | undefined {
  return records[wslMoveOrchestratorDistroKey(distro)]
}

function byDistro(list: readonly WslMoveOrchestratorRecord[]) {
  return Object.fromEntries(
    list.map((record) => [wslMoveOrchestratorDistroKey(record.distro), record])
  )
}

/** Toasts for what became done or parked since the last update; none for a first load. */
function announce(
  previous: Record<string, WslMoveOrchestratorRecord>,
  next: Record<string, WslMoveOrchestratorRecord>
): void {
  for (const [key, record] of Object.entries(next)) {
    const before = previous[key]?.state.kind
    if (record.state.kind === before) {
      continue
    }
    if (record.state.kind === 'done') {
      toast.success(
        translate('wslMove.orchestrator.doneToast', 'Projects moved to the {{distro}} host', {
          distro: record.distro
        })
      )
    } else if (record.state.kind === 'parked') {
      const message = wslMoveOrchestratorParkedToast(record)
      if (message) {
        toast(message)
      }
    }
  }
}

/** Starts following main's records; returns the stop. Call only while WSL hosts are on. */
export function followWslMoveOrchestratorStatus(): () => void {
  let live = true
  let loaded = false
  const stop = window.api.wslMove.onOrchestratorStatus((list) => {
    if (!live) {
      return
    }
    const next = byDistro(list)
    if (loaded) {
      announce(useWslMoveOrchestratorStatus.getState().records, next)
    }
    loaded = true
    useWslMoveOrchestratorStatus.setState({ records: next })
  })
  void window.api.wslMove.listOrchestrator().then((list) => {
    // A live update that arrived first is newer than this snapshot.
    if (live && !loaded) {
      loaded = true
      useWslMoveOrchestratorStatus.setState({ records: byDistro(list) })
    }
  })
  return () => {
    live = false
    stop()
    useWslMoveOrchestratorStatus.setState({ records: {} })
  }
}
