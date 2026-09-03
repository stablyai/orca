import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import { makePaneKey, type PaneKey } from '../../../shared/stable-pane-id'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal-input'
import { useAppStore } from '../store'
import { callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from './runtime-terminal-stream'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import {
  classifyTerminalProcessInspectionFailure,
  clientOnlyUnverifiableInspection,
  isClientOnlyUnverifiableInspection,
  type TerminalProcessInspection
} from '../../../shared/terminal-process-inspection'

export type {
  ClientOnlyUnverifiableInspection,
  ClientOnlyUnverifiableReason
} from '../../../shared/terminal-process-inspection'

export type RuntimeTerminalProcessInspection = TerminalProcessInspection

const REMOTE_PTY_ID_PREFIX = 'remote:'
const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const
type TerminalLayoutsByTabId = ReturnType<typeof useAppStore.getState>['terminalLayoutsByTabId']
type TerminalPaneOwner = {
  tabId: string
  leafId: string
  paneKey: PaneKey
}

const paneOwnersByPtyIdByLayoutIdentity = new WeakMap<
  TerminalLayoutsByTabId,
  Map<string, TerminalPaneOwner>
>()

function resolvePaneKeyForPtyId(layouts: TerminalLayoutsByTabId, ptyId: string): PaneKey | null {
  let paneOwnersByPtyId = paneOwnersByPtyIdByLayoutIdentity.get(layouts)
  if (!paneOwnersByPtyId) {
    paneOwnersByPtyId = new Map<string, TerminalPaneOwner>()
    paneOwnersByPtyIdByLayoutIdentity.set(layouts, paneOwnersByPtyId)
  }
  const cachedOwner = paneOwnersByPtyId.get(ptyId)
  if (cachedOwner) {
    const layout = Object.prototype.propertyIsEnumerable.call(layouts, cachedOwner.tabId)
      ? layouts[cachedOwner.tabId]
      : undefined
    const ptyIdsByLeafId = layout?.ptyIdsByLeafId
    if (
      ptyIdsByLeafId &&
      Object.prototype.propertyIsEnumerable.call(ptyIdsByLeafId, cachedOwner.leafId) &&
      ptyIdsByLeafId[cachedOwner.leafId] === ptyId
    ) {
      return cachedOwner.paneKey
    }
    paneOwnersByPtyId.delete(ptyId)
  }
  for (const [tabId, layout] of Object.entries(layouts)) {
    for (const [leafId, leafPtyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
      if (leafPtyId !== ptyId) {
        continue
      }
      try {
        const paneKey = makePaneKey(tabId, leafId)
        paneOwnersByPtyId.set(ptyId, { tabId, leafId, paneKey })
        return paneKey
      } catch {
        // Preserve first-match behavior for malformed legacy layout rows.
        return null
      }
    }
  }
  return null
}

function isRuntimePtyInputTooLarge(data: string): boolean | Promise<boolean> {
  return isTerminalInputTooLargeWithDeferredMeasurement(data)
}

export function isRemoteRuntimePtyId(ptyId: string): boolean {
  return ptyId.startsWith(REMOTE_PTY_ID_PREFIX)
}

function isRemoteInspectionPtyId(ptyId: string): boolean {
  return getRemoteRuntimePtyEnvironmentId(ptyId) !== null || parseAppSshPtyId(ptyId) !== null
}

function normalizeInspectionResult(
  result: TerminalProcessInspection,
  remote: boolean
): RuntimeTerminalProcessInspection {
  if (typeof result !== 'object' || result === null) {
    return clientOnlyUnverifiableInspection(remote ? 'old_host' : 'terminal_gone')
  }
  // A client-only result may have crossed a mixed-version preload/runtime boundary.
  if (isClientOnlyUnverifiableInspection(result)) {
    return clientOnlyUnverifiableInspection(
      typeof result.reason === 'string' ? result.reason : 'transport_loss'
    )
  }
  // An old host has no evidence member. Its compatibility process name is not
  // an observation and must never reach remote identity consumers.
  if (remote && result.foregroundProcessEvidence === undefined) {
    return clientOnlyUnverifiableInspection('old_host')
  }
  // Older main/preload pairs may still return the removed boolean. Normalize it
  // at the boundary while those peers are being upgraded.
  if (
    result &&
    typeof result === 'object' &&
    'unavailable' in result &&
    (result as { unavailable?: unknown }).unavailable === true
  ) {
    return clientOnlyUnverifiableInspection('terminal_gone')
  }
  return result
}

export function recordRuntimeTerminalInputForPtyId(ptyId: string, timestamp = Date.now()): void {
  const state = useAppStore.getState()
  const paneKey = resolvePaneKeyForPtyId(state.terminalLayoutsByTabId, ptyId)
  if (!paneKey) {
    return
  }
  try {
    // Why: paired/runtime sends can bypass xterm.onData, so hibernation
    // needs the same user-input marker from the PTY-id route.
    state.recordTerminalInput(paneKey, timestamp)
  } catch {
    // Ignore malformed legacy layout data; the planner will stay
    // conservative when a live PTY cannot be matched to an eligible pane.
  }
}

export async function inspectRuntimeTerminalProcess(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  options?: { expectedIncarnationId?: string }
): Promise<RuntimeTerminalProcessInspection> {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  const remote = isRemoteInspectionPtyId(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    try {
      const result = await (options?.expectedIncarnationId
        ? window.api.pty.inspectProcess(ptyId, options)
        : window.api.pty.inspectProcess(ptyId))
      return normalizeInspectionResult(result, remote)
    } catch (error) {
      const reason = classifyTerminalProcessInspectionFailure(error)
      if (reason) {
        return clientOnlyUnverifiableInspection(reason)
      }
      throw error
    }
  }

  try {
    const result = await callRuntimeRpc<{ process: RuntimeTerminalProcessInspection }>(
      target,
      'terminal.inspectProcess',
      {
        terminal,
        ...(options?.expectedIncarnationId
          ? { expectedIncarnationId: options.expectedIncarnationId }
          : {})
      },
      { timeoutMs: 15_000 }
    )
    return normalizeInspectionResult(result.process, true)
  } catch (error) {
    const reason = classifyTerminalProcessInspectionFailure(error)
    if (reason) {
      return clientOnlyUnverifiableInspection(reason)
    }
    throw error
  }
}

/**
 * Forces a fresh, uncached foreground scan for a pane whose cached inspection
 * is suspect (issue #11064: the cached read can flap to the shell for a live
 * agent). Local/daemon panes only — runtime environments expose no fresh-scan
 * RPC, and an SSH provider without confirm support answers null, which callers
 * must read as "no new evidence", never as a shell confirmation.
 */
export async function confirmRuntimeTerminalForegroundProcess(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string
): Promise<string | null> {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  if (target.kind === 'environment' && getRemoteRuntimeTerminalHandle(ptyId)) {
    return null
  }
  const confirmForegroundProcess = window.api.pty.confirmForegroundProcess
  // Why the shape check: a preload older than this handler has no such method.
  if (typeof confirmForegroundProcess !== 'function') {
    return null
  }
  return confirmForegroundProcess(ptyId).catch(() => null)
}

export function sendRuntimePtyInput(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string
): boolean {
  const tooLarge = isRuntimePtyInputTooLarge(data)
  if (tooLarge === true) {
    return false
  }
  if (tooLarge !== false) {
    // Why: this is a fire-and-forget path, so accepted paste-sized input must
    // yield before validation and then dispatch without blocking the renderer.
    void tooLarge
      .then((resolvedTooLarge) => {
        if (!resolvedTooLarge) {
          sendRuntimePtyInputWithinLimit(settings, ptyId, data)
        }
      })
      .catch(() => {})
    return true
  }
  return sendRuntimePtyInputWithinLimit(settings, ptyId, data)
}

function sendRuntimePtyInputWithinLimit(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string
): boolean {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    window.api.pty.write(ptyId, data)
    recordRuntimeTerminalInputForPtyId(ptyId)
    return true
  }

  void callRuntimeRpc<{ send: RuntimeTerminalSend }>(
    target,
    'terminal.send',
    { terminal, text: data, client: DESKTOP_RUNTIME_CLIENT },
    { timeoutMs: 15_000 }
  )
    .then((result) => {
      if (result.send.accepted === true) {
        recordRuntimeTerminalInputForPtyId(ptyId)
      }
    })
    .catch(() => {
      // Why: web session snapshots can retire a remote handle while xterm still
      // flushes a final input event. The next host snapshot will reattach.
    })
  return true
}

export async function sendRuntimePtyInputVerified(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string,
  data: string
): Promise<boolean> {
  const tooLarge = isRuntimePtyInputTooLarge(data)
  if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
    return false
  }
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    const accepted = await window.api.pty.writeAccepted(ptyId, data)
    if (!accepted) {
      window.api.pty.write(ptyId, data)
      // Why: SSH/local fallback writes are fire-and-forget. Callers use this
      // boolean to continue UX flow, while hook telemetry confirms real turns.
      recordRuntimeTerminalInputForPtyId(ptyId)
      return true
    }
    recordRuntimeTerminalInputForPtyId(ptyId)
    return accepted
  }

  try {
    const result = await callRuntimeRpc<{ send: RuntimeTerminalSend }>(
      target,
      'terminal.send',
      { terminal, text: data, client: DESKTOP_RUNTIME_CLIENT },
      { timeoutMs: 15_000 }
    )
    if (result.send.accepted === true) {
      recordRuntimeTerminalInputForPtyId(ptyId)
      return true
    }
    return false
  } catch (error) {
    if (classifyTerminalProcessInspectionFailure(error) === 'terminal_gone') {
      return false
    }
    throw error
  }
}
