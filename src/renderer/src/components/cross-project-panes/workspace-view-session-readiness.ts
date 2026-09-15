import { useAppStore } from '@/store'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { tabExecutionHost } from '@/store/slices/window-pane-selection'
import { findWorkspaceViewSession, type WorkspaceViewPacket } from './workspace-view-packet'

export async function resolveHosts(): Promise<Record<string, string>> {
  const state = useAppStore.getState()
  const hosts = new Set(
    Object.values(state.unifiedTabsByWorktree)
      .flat()
      .map((tab) => tabExecutionHost(state, tab))
      .filter(Boolean)
  )
  const result: Record<string, string> = {}
  await Promise.all(
    [...hosts].map(async (id) => {
      const host = parseExecutionHostId(id)
      if (!host) {
        return
      }
      if (
        host.kind === 'ssh' &&
        state.sshConnectionStates.get(host.targetId)?.status !== 'connected'
      ) {
        return
      }
      try {
        const status = await callRuntimeRpc<{ runtimeId: string }>(
          host.kind === 'runtime'
            ? { kind: 'environment', environmentId: host.environmentId }
            : { kind: 'local' },
          'status.get'
        )
        if (status.runtimeId) {
          result[host.id] = status.runtimeId
        }
      } catch {
        /* Unreachable owners cannot accept a view. */
      }
    })
  )
  for (const id of Object.keys(result)) {
    const host = parseExecutionHostId(id)
    if (
      host?.kind === 'ssh' &&
      useAppStore.getState().sshConnectionStates.get(host.targetId)?.status !== 'connected'
    ) {
      delete result[id]
    }
  }
  return result
}

export function waitForWorkspaceViewSessions(
  packet: WorkspaceViewPacket,
  signal: AbortSignal
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let checking = false
    let finished = false
    let revision = 0
    const finish = (hosts?: Record<string, string>): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(timeout)
      stop()
      signal.removeEventListener('abort', abort)
      if (hosts) {
        resolve(hosts)
      } else {
        reject(new Error('Session unavailable'))
      }
    }
    const check = async (): Promise<void> => {
      if (checking || finished || !useAppStore.getState().workspaceSessionReady) {
        return
      }
      checking = true
      const currentRevision = revision
      const hosts = await resolveHosts()
      checking = false
      const state = useAppStore.getState()
      if (packet.views.every((entry) => findWorkspaceViewSession(state, entry, hosts))) {
        finish(hosts)
      } else if (revision !== currentRevision) {
        void check()
      }
    }
    const abort = (): void => finish()
    const timeout = setTimeout(abort, 10_000)
    const stop = useAppStore.subscribe(() => {
      revision++
      void check()
    })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) {
      abort()
    } else {
      void check()
    }
  })
}
