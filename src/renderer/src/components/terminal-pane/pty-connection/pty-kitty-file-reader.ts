import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/runtime-environment-revision'
import { bindTerminalKittyFileReader } from '@/lib/pane-manager/terminal-kitty-file-reader'
import { waitForPromiseWithSignal } from '../../../../../shared/abort-signal-reason'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toHostSessionTabId
} from '../../../../../shared/terminal-surface-id'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import type { RuntimeTerminalResolvePane } from '../../../../../shared/runtime-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installPtyKittyFileReader(session: ConnectPanePtySession): void {
  const lifetime = new AbortController()
  const unbind = bindTerminalKittyFileReader(session.pane.terminal, async (request) => {
    const ptyId = session.transport.getPtyId()
    if (!ptyId || session.disposed || session.terminalOwnerUnresolved) {
      throw new Error('Terminal file transport is unavailable')
    }
    const signal = AbortSignal.any([request.signal, lifetime.signal, AbortSignal.timeout(5000)])
    const target: RuntimeClientTarget =
      session.runtimeEnvironmentId === null
        ? { kind: 'local' }
        : { kind: 'environment', environmentId: session.runtimeEnvironmentId }
    const options = {
      signal,
      timeoutMs: 5000,
      suppressFeatureInteraction: true,
      expectedEnvironmentPairingRevision:
        target.kind === 'environment'
          ? captureRuntimeEnvironmentRequestRevision(target.environmentId)
          : undefined
    }
    const resolved = await waitForPromiseWithSignal(
      callRuntimeRpc<{ terminal: RuntimeTerminalResolvePane }>(
        target,
        'terminal.resolvePane',
        {
          paneKey:
            target.kind === 'environment'
              ? `${toHostSessionTabId(session.deps.tabId).split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]}:${session.pane.leafId}`
              : session.cacheKey,
          worktreeId: session.deps.worktreeId
        },
        options
      ),
      signal
    )
    const resolvedPtyId =
      target.kind === 'environment'
        ? toRemoteRuntimePtyId(resolved.terminal.handle, target.environmentId)
        : resolved.terminal.ptyId
    if (
      !resolved.terminal.ptyId ||
      session.transport.getPtyId() !== ptyId ||
      resolvedPtyId !== ptyId
    ) {
      throw new Error('Terminal binding changed')
    }
    const result = await waitForPromiseWithSignal(
      callRuntimeRpc<{ base64: string }>(
        target,
        'terminal.readKittyFile',
        {
          terminal: resolved.terminal.handle,
          path: request.path,
          ...(resolved.terminal.incarnationId
            ? { expectedIncarnationId: resolved.terminal.incarnationId }
            : {}),
          offset: request.offset,
          ...(request.length !== undefined ? { length: request.length } : {})
        },
        options
      ),
      signal
    )
    if (session.transport.getPtyId() !== ptyId) {
      throw new Error('Terminal binding changed')
    }
    if (typeof result.base64 !== 'string' || result.base64.length > 2_796_204) {
      throw new Error('Terminal image exceeds transport limit')
    }
    const bytes = Uint8Array.from(atob(result.base64), (char) => char.charCodeAt(0))
    if (bytes.length > 2 * 1024 * 1024) {
      throw new Error('Terminal image exceeds transport limit')
    }
    return bytes
  })
  session.cleanupKittyFileReader = () => {
    lifetime.abort()
    unbind()
  }
}
