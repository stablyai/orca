import type { GlobalSettings } from '../../../shared/types'
import type { RuntimeTerminalSend } from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { isTerminalInputTooLargeWithDeferredMeasurement } from '../../../shared/terminal-input'
import { useAppStore } from '../store'
import { RuntimeRpcCallError, callRuntimeRpc, getActiveRuntimeTarget } from './runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from './runtime-terminal-stream'

export type RuntimeTerminalProcessInspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  // Why: callers must not treat a stale remote handle as authoritative idle evidence.
  unavailable?: true
}

const REMOTE_PTY_ID_PREFIX = 'remote:'
const DESKTOP_RUNTIME_CLIENT = { id: 'orca-desktop', type: 'desktop' } as const

function isRuntimePtyInputTooLarge(data: string): boolean | Promise<boolean> {
  return isTerminalInputTooLargeWithDeferredMeasurement(data)
}

export function isRemoteRuntimePtyId(ptyId: string): boolean {
  return ptyId.startsWith(REMOTE_PTY_ID_PREFIX)
}

function isTerminalGoneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code =
    error instanceof RuntimeRpcCallError
      ? error.code
      : error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : ''
  return (
    code === 'no_connected_pty' ||
    code === 'terminal_handle_stale' ||
    code === 'terminal_exited' ||
    code === 'terminal_gone' ||
    message.includes('terminal_handle_stale') ||
    message.includes('terminal_exited') ||
    message.includes('terminal_gone') ||
    message.includes('no_connected_pty')
  )
}

export function recordRuntimeTerminalInputForPtyId(ptyId: string, timestamp = Date.now()): void {
  const state = useAppStore.getState()
  for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    for (const [leafId, leafPtyId] of Object.entries(layout?.ptyIdsByLeafId ?? {})) {
      if (leafPtyId !== ptyId) {
        continue
      }
      try {
        // Why: paired/runtime sends can bypass xterm.onData, so hibernation
        // needs the same user-input marker from the PTY-id route.
        state.recordTerminalInput(makePaneKey(tabId, leafId), timestamp)
      } catch {
        // Ignore malformed legacy layout data; the planner will stay
        // conservative when a live PTY cannot be matched to an eligible pane.
      }
      return
    }
  }
}

export async function inspectRuntimeTerminalProcess(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  ptyId: string
): Promise<RuntimeTerminalProcessInspection> {
  const ownerEnvironmentId = getRemoteRuntimePtyEnvironmentId(ptyId)
  const target = ownerEnvironmentId
    ? ({ kind: 'environment', environmentId: ownerEnvironmentId } as const)
    : getActiveRuntimeTarget(settings)
  const terminal = getRemoteRuntimeTerminalHandle(ptyId)
  if (target.kind !== 'environment' || !terminal) {
    return window.api.pty.inspectProcess(ptyId)
  }

  try {
    const result = await callRuntimeRpc<{ process: RuntimeTerminalProcessInspection }>(
      target,
      'terminal.inspectProcess',
      { terminal },
      { timeoutMs: 15_000 }
    )
    return result.process
  } catch (error) {
    if (isTerminalGoneError(error)) {
      return { foregroundProcess: null, hasChildProcesses: false, unavailable: true }
    }
    throw error
  }
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
    if (isTerminalGoneError(error)) {
      return false
    }
    throw error
  }
}
