import type { PtyApi } from '../../../../preload/api/terminal/pty-api'
import type { PtySessionListScope } from '../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import type { RuntimeTerminalListResult } from '../../../../shared/terminal/runtime/runtime-terminal-contracts'
import { hostScopeCensusIsComplete } from '../../../../shared/execution-host/runtime-listing-host-scope'
import {
  parseRemoteRuntimePtyId,
  toRemoteRuntimePtyId
} from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import {
  classifyTerminalProcessInspectionFailure,
  clientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from '../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'
import { unwrapRuntimeRpcResult } from '../../runtime/rpc/calls/runtime-rpc-result'
import { callEnvironmentEnvelope } from '../runtime/client/web-runtime-calls'
import { requireActiveEnvironment } from '../runtime/client/web-runtime-session'
import { callTauriPtyHost } from './web-tauri-pty-host'

type MainBufferSnapshot = Awaited<ReturnType<PtyApi['getMainBufferSnapshot']>>

function listedPtyIsLive(result: RuntimeTerminalListResult, handle: string): boolean | null {
  const terminal = result.terminals.find((candidate) => candidate.handle === handle)
  if (terminal) {
    return terminal.ptyId === undefined ? null : terminal.ptyId !== null
  }
  // Absence from a truncated or partially observed inventory cannot prove process death.
  return !result.truncated && hostScopeCensusIsComplete(result.hostScope) ? false : null
}

async function inspectRuntimeProcess(
  id: string,
  options?: { expectedIncarnationId?: string; scanChildProcesses?: boolean; steadyState?: boolean }
): Promise<TerminalProcessInspection> {
  const owner = parseRemoteRuntimePtyId(id)
  if (!owner?.environmentId) {
    return clientOnlyUnverifiableInspection('old_host')
  }
  try {
    const result = await callTauriPtyHost<{ process: TerminalProcessInspection }>(
      id,
      'terminal.inspectProcess',
      {
        terminal: owner.handle,
        ...(options?.expectedIncarnationId
          ? { expectedIncarnationId: options.expectedIncarnationId }
          : {}),
        ...(options?.scanChildProcesses === true ? { scanChildProcesses: true } : {})
      }
    )
    return result.process
  } catch (error) {
    const reason = classifyTerminalProcessInspectionFailure(error)
    if (!reason) {
      throw error
    }
    return clientOnlyUnverifiableInspection(reason)
  }
}

async function readRuntimePtySessions(scope?: PtySessionListScope) {
  if (scope?.connectionId !== undefined && scope.connectionId !== null) {
    return []
  }
  const environmentId = requireActiveEnvironment().id
  const result = unwrapRuntimeRpcResult(
    await callEnvironmentEnvelope<RuntimeTerminalListResult>(environmentId, 'terminal.list', {})
  )
  return result.terminals.flatMap((terminal) =>
    terminal.ptyId
      ? [
          {
            id: toRemoteRuntimePtyId(terminal.handle, environmentId),
            cwd: terminal.worktreePath,
            title: terminal.title ?? '',
            worktreeId: terminal.worktreeId,
            agentOwnership: terminal.agentIdentity ? ('present' as const) : ('unknown' as const)
          }
        ]
      : []
  )
}

async function readSnapshotCapabilities(ids: string[]) {
  const groups = new Map<string, Map<string, string>>()
  const capabilities = new Map<string, boolean | null>()
  for (const id of ids) {
    const owner = parseRemoteRuntimePtyId(id)
    if (!owner?.environmentId) {
      continue
    }
    const group = groups.get(owner.environmentId) ?? new Map<string, string>()
    group.set(owner.handle, id)
    groups.set(owner.environmentId, group)
  }
  await Promise.all(
    [...groups.values()].map(async (group) => {
      const entries = [...group]
      // The shared terminal.list contract accepts at most 64 handles per request.
      for (let offset = 0; offset < entries.length; offset += 64) {
        const batch = entries.slice(offset, offset + 64)
        try {
          const result = await callTauriPtyHost<RuntimeTerminalListResult>(
            batch[0][1],
            'terminal.list',
            {
              handles: batch.map(([handle]) => handle),
              limit: batch.length,
              requireFreshPtyLiveness: true,
              includeVisualLayouts: false
            }
          )
          for (const [handle, id] of batch) {
            capabilities.set(id, listedPtyIsLive(result, handle))
          }
        } catch {
          for (const [, id] of batch) {
            capabilities.set(id, null)
          }
        }
      }
    })
  )
  return ids.map((id) => ({ id, authoritative: capabilities.get(id) ?? null }))
}

async function hasRuntimePty(id: string): Promise<boolean | null> {
  const owner = parseRemoteRuntimePtyId(id)
  if (!owner?.environmentId) {
    return null
  }
  try {
    const result = await callTauriPtyHost<RuntimeTerminalListResult>(id, 'terminal.list', {
      handles: [owner.handle],
      requireFreshPtyLiveness: true,
      includeVisualLayouts: false
    })
    return listedPtyIsLive(result, owner.handle)
  } catch {
    return null
  }
}

async function readRuntimeBufferSnapshot(
  id: string,
  opts?: { scrollbackRows?: number }
): Promise<MainBufferSnapshot> {
  const owner = parseRemoteRuntimePtyId(id)
  if (!owner?.environmentId) {
    return null
  }
  try {
    const result = await callTauriPtyHost<{ snapshot: MainBufferSnapshot }>(
      id,
      'terminal.bufferSnapshot',
      {
        terminal: owner.handle,
        ...(opts?.scrollbackRows === undefined ? {} : { scrollbackRows: opts.scrollbackRows })
      }
    )
    return result.snapshot
  } catch {
    return null
  }
}

export function createRuntimePtyQueryApi() {
  return {
    hasChildProcesses: async (id: string) => (await inspectRuntimeProcess(id)).hasChildProcesses,
    getForegroundProcess: async (id: string) => (await inspectRuntimeProcess(id)).foregroundProcess,
    inspectProcess: inspectRuntimeProcess,
    listSessions: readRuntimePtySessions,
    getAuthoritativeBufferSnapshotCapabilities: readSnapshotCapabilities,
    hasPty: hasRuntimePty,
    getMainBufferSnapshot: readRuntimeBufferSnapshot
  } satisfies Pick<
    PtyApi,
    | 'hasChildProcesses'
    | 'getForegroundProcess'
    | 'inspectProcess'
    | 'listSessions'
    | 'getAuthoritativeBufferSnapshotCapabilities'
    | 'hasPty'
    | 'getMainBufferSnapshot'
  >
}
