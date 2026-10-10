import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalResolvePane
} from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { runInTerminalRecoveryRpcLane } from './web-session-terminal-orphan-recovery-rpc-lane'
import {
  cacheStablePaneResolutionFailure,
  readStablePaneResolutionFailure
} from './web-session-terminal-orphan-recovery-cache'
import type {
  RecoverySurface,
  UnresolvedRecoverySurface
} from './web-session-terminal-orphan-recovery-surface'

type RuntimeCall = (args: {
  selector: string
  method: string
  params: unknown
  timeoutMs: number
  expectedEnvironmentPairingRevision?: number
}) => Promise<RuntimeRpcResponse<unknown>>

type PaneResolution = {
  resolved: RecoverySurface[]
  unresolved: UnresolvedRecoverySurface[]
}

type ResolvedPaneResponse =
  | { kind: 'connected'; terminal: RuntimeTerminalResolvePane }
  | { kind: 'disconnected' }
  | { kind: 'invalid' }

const MAX_PANE_RESOLVES = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readResolvedPane(value: unknown): ResolvedPaneResponse {
  if (!isRecord(value) || !isRecord(value.terminal)) {
    return { kind: 'invalid' }
  }
  const terminal = value.terminal
  if (
    typeof terminal.handle !== 'string' ||
    terminal.handle.length === 0 ||
    typeof terminal.tabId !== 'string' ||
    typeof terminal.leafId !== 'string' ||
    (terminal.ptyId !== null &&
      (typeof terminal.ptyId !== 'string' || terminal.ptyId.length === 0)) ||
    typeof terminal.connected !== 'boolean' ||
    typeof terminal.worktreeId !== 'string'
  ) {
    return { kind: 'invalid' }
  }
  if (!terminal.connected) {
    return { kind: 'disconnected' }
  }
  return {
    kind: 'connected',
    terminal: {
      handle: terminal.handle,
      tabId: terminal.tabId,
      leafId: terminal.leafId,
      ptyId: terminal.ptyId,
      connected: true,
      worktreeId: terminal.worktreeId
    }
  }
}

function matchesSurface(
  terminal: RuntimeTerminalResolvePane,
  surface: UnresolvedRecoverySurface,
  worktreeId: string
): boolean {
  return (
    terminal.tabId === surface.tabId &&
    terminal.leafId === surface.leafId &&
    terminal.worktreeId === worktreeId &&
    (!surface.expectedPtyId || terminal.ptyId === surface.expectedPtyId)
  )
}

function resolvedSurface(
  surface: UnresolvedRecoverySurface,
  terminal: RuntimeTerminalResolvePane
): RecoverySurface {
  return { ...surface, handle: terminal.handle }
}

async function resolveOne(args: {
  surface: UnresolvedRecoverySurface
  snapshot: RuntimeMobileSessionTabsResult
  environmentId: string
  call: RuntimeCall
  expectedEnvironmentPairingRevision?: number
  isCurrent: () => boolean
}): Promise<RecoverySurface | null> {
  const { surface, snapshot, environmentId, call, expectedEnvironmentPairingRevision, isCurrent } =
    args
  if (!isCurrent()) {
    return null
  }
  const cacheFailure = (): void => {
    if (isCurrent()) {
      cacheStablePaneResolutionFailure({
        environmentId,
        snapshot,
        surface,
        expectedEnvironmentPairingRevision
      })
    }
  }
  if (
    readStablePaneResolutionFailure({
      environmentId,
      snapshot,
      surface,
      expectedEnvironmentPairingRevision
    })
  ) {
    return null
  }
  let paneKey: string
  try {
    paneKey = makePaneKey(surface.tabId, surface.leafId)
  } catch {
    // Legacy/corrupt layouts cannot be safely addressed; keep the surface pending.
    cacheFailure()
    return null
  }
  try {
    const response = await runInTerminalRecoveryRpcLane(isCurrent, () =>
      call({
        selector: environmentId,
        method: 'terminal.resolvePane',
        params: {
          paneKey,
          worktreeId: snapshot.worktree
        },
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision
      })
    )
    if (!response?.ok) {
      if (response?.error.code === 'method_not_found') {
        cacheFailure()
      }
      return null
    }
    const resolution = readResolvedPane(response.result)
    if (resolution.kind === 'invalid') {
      cacheFailure()
      return null
    }
    if (resolution.kind === 'disconnected') {
      return null
    }
    const { terminal } = resolution
    if (!matchesSurface(terminal, surface, snapshot.worktree)) {
      return null
    }
    return resolvedSurface(surface, terminal)
  } catch {
    return null
  }
}

export async function resolvePersistedTerminalSurfaces(args: {
  surfaces: readonly UnresolvedRecoverySurface[]
  snapshot: RuntimeMobileSessionTabsResult
  environmentId: string
  call: RuntimeCall
  expectedEnvironmentPairingRevision?: number
  isCurrent: () => boolean
}): Promise<PaneResolution | null> {
  const { surfaces, isCurrent } = args
  if (surfaces.length === 0) {
    return { resolved: [], unresolved: [] }
  }
  if (surfaces.length > MAX_PANE_RESOLVES) {
    return { resolved: [], unresolved: [...surfaces] }
  }
  const outcomes = await Promise.all(
    surfaces.map(async (surface) => ({
      surface,
      resolved: await resolveOne({ ...args, surface })
    }))
  )
  if (!isCurrent()) {
    return null
  }
  return {
    resolved: outcomes.flatMap(({ resolved }) => (resolved ? [resolved] : [])),
    unresolved: outcomes.flatMap(({ surface, resolved }) => (resolved ? [] : [surface]))
  }
}
