import type { GlobalSettings } from '../../../shared/global-settings-types'
import { ANTIGRAVITY_VISIBLE_READINESS_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type {
  RuntimeTerminalResolvePane,
  RuntimeTerminalShow,
  RuntimeTerminalWait
} from '../../../shared/runtime-types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '@/store'
import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  hasRuntimeRpcErrorCode,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'

/** The host's recorded-screen classifier owns readiness; shell paste mode is not agent input. */
export async function waitForAntigravityDraftReady(
  tabId: string,
  ptyId: string,
  timeoutMs: number,
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): Promise<boolean> {
  const remotePty = parseRemoteRuntimePtyId(ptyId)
  const target = remotePty?.environmentId
    ? ({ kind: 'environment', environmentId: remotePty.environmentId } as const)
    : getActiveRuntimeTarget(settings)
  const deadline = Date.now() + timeoutMs
  const stillOwnsPty = (): boolean =>
    useAppStore.getState().ptyIdsByTabId[tabId]?.includes(ptyId) === true
  try {
    const supported =
      target.kind === 'environment'
        ? await runtimeEnvironmentSupportsCapability(
            target.environmentId,
            ANTIGRAVITY_VISIBLE_READINESS_RUNTIME_CAPABILITY,
            Math.min(timeoutMs, 5000)
          )
        : (await ensureLocalRuntimeCapabilities())?.includes(
            ANTIGRAVITY_VISIBLE_READINESS_RUNTIME_CAPABILITY
          ) === true
    if (!supported) {
      return false
    }
    while (stillOwnsPty() && Date.now() < deadline) {
      const layout = useAppStore.getState().terminalLayoutsByTabId[tabId]
      const leafId = Object.entries(layout?.ptyIdsByLeafId ?? {}).find(
        ([, value]) => value === ptyId
      )?.[0]
      if (leafId) {
        const { terminal } = await callRuntimeRpc<{
          terminal: RuntimeTerminalResolvePane | null
        }>(
          target,
          'terminal.resolvePane',
          { paneKey: makePaneKey(toHostSessionTabId(tabId), leafId) },
          { timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now())) }
        ).catch((error: unknown) => {
          if (hasRuntimeRpcErrorCode(error, 'terminal_not_found')) {
            return { terminal: null }
          }
          throw error
        })
        const remoteHandle = remotePty?.handle
        const samePty = remoteHandle ? terminal?.handle === remoteHandle : terminal?.ptyId === ptyId
        if (terminal && samePty && stillOwnsPty()) {
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            return false
          }
          const { wait } = await callRuntimeRpc<{ wait: RuntimeTerminalWait }>(
            target,
            'terminal.wait',
            { terminal: terminal.handle, for: 'tui-idle', timeoutMs: remaining },
            { timeoutMs: remaining + 1000 }
          )
          if (
            !stillOwnsPty() ||
            wait.handle !== terminal.handle ||
            !wait.satisfied ||
            wait.status !== 'running' ||
            wait.blockedReason
          ) {
            return false
          }
          const { terminal: current } = await callRuntimeRpc<{ terminal: RuntimeTerminalShow }>(
            target,
            'terminal.show',
            { terminal: terminal.handle },
            { timeoutMs: 5000 }
          )
          return (
            stillOwnsPty() &&
            current.handle === terminal.handle &&
            current.connected &&
            current.writable &&
            current.agentIdentity === 'antigravity' &&
            (remoteHandle ? current.handle === remoteHandle : current.ptyId === ptyId)
          )
        }
      }
      // The PTY can bind before its pane appears in the host's window graph.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 100))
    }
  } catch {
    // A disconnected or older host never licenses a best-effort paste.
  }
  return false
}
