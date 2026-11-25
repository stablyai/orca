// Agent terminals that outlive their host's restart keep the relay address and token of its last
// run, so every server reached through it stops working. Once each host has started and taken its
// terminals back (Orca itself, or a new run of a remote host), offer the restart an edit offers.
import { useEffect } from 'react'
import { useAppStore } from '../../../store/index'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { remoteRestartRuntimeId } from '../../native-chat-recovery/offers/native-chat-remote-restart-offer'
import { showMcpStaleTerminalsToast } from './mcp-server-change-toast'

/** The host run each host was last checked for: once per run, however often its status changes. */
const checkedRuns = new Map<string, string>()

function checkOnce(hostKey: string, run: string, check: () => Promise<void>): void {
  if (checkedRuns.get(hostKey) === run) {
    return
  }
  checkedRuns.set(hostKey, run)
  void check()
}

export function McpStaleTerminalsStartupOffer(): null {
  // Restoration has adopted every terminal that outlived the restart by then.
  const localReady = useAppStore(
    (state) => state.workspaceSessionReady && state.terminalStartupRestorationReady
  )
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const statuses = useRuntimeStatusByEnvironmentId()
  useEffect(() => {
    if (localReady) {
      checkOnce('local', 'local', () => showMcpStaleTerminalsToast({ kind: 'local' }, null))
    }
  }, [localReady])
  useEffect(() => {
    const enrolled = new Set(environments.map((environment) => environment.id))
    for (const hostKey of checkedRuns.keys()) {
      if (hostKey !== 'local' && !enrolled.has(hostKey)) {
        checkedRuns.delete(hostKey)
      }
    }
    for (const environment of environments) {
      const runtimeId = remoteRestartRuntimeId(statuses.get(environment.id))
      if (runtimeId) {
        checkOnce(environment.id, runtimeId, () =>
          showMcpStaleTerminalsToast(
            { kind: 'environment', environmentId: environment.id },
            environment.name || environment.id
          )
        )
      }
    }
  }, [environments, statuses])
  return null
}
