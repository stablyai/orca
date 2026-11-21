import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { hasPtySerializer } from '../../snapshots/pty-buffer-serializer'
import { waitForTerminalOutputParsed } from '@/lib/pane-manager/terminal-output/pane-terminal-output-scheduler'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export function declareFreshPaneSerializer(session: ConnectPanePtySession) {
  const paneKey = session.cacheKey
  const pending = session.runtimeEnvironmentId
    ? Promise.resolve(null)
    : window.api.pty.declarePendingPaneSerializer(paneKey).catch(() => null)
  return {
    pending,
    clear: (): void => {
      void pending.then((generation) => {
        if (typeof generation === 'number') {
          void window.api.pty.clearPendingPaneSerializer(paneKey, generation).catch(() => {})
        }
      })
    }
  }
}

export function bindPaneSerializerReadiness(session: ConnectPanePtySession): void {
  session.settlePaneSerializerAfterReplay = async (
    ptyId: string,
    generation: number
  ): Promise<void> => {
    try {
      await session.replayWriteQueue
      if (session.disposed || session.transport.getPtyId() !== ptyId) {
        await window.api.pty
          .clearPendingPaneSerializer(session.cacheKey, generation)
          .catch(() => {})
        return
      }
      await waitForTerminalOutputParsed(session.pane.terminal)
      if (!session.disposed && session.transport.getPtyId() === ptyId) {
        await window.api.pty.settlePaneSerializer(session.cacheKey, generation)
        return
      }
    } catch {
      // Clear below so a failed parser/replay cannot leave the pane generation pending.
    }
    await window.api.pty.clearPendingPaneSerializer(session.cacheKey, generation).catch(() => {})
  }
  session.reportRemoteRendererSerializerReady = (): void => {
    const ptyId = session.transport.getPtyId()
    if (!ptyId || !isRemoteRuntimePtyId(ptyId)) {
      return
    }
    if (!hasPtySerializer(ptyId)) {
      session.registerPaneSerializerFor(ptyId)
    }
    // Join async snapshot replay and xterm parse after onSubscribed before declaring readiness.
    void session.replayWriteQueue
      .then(() => waitForTerminalOutputParsed(session.pane.terminal))
      .then(() => {
        if (!session.disposed && session.transport.getPtyId() === ptyId) {
          void window.api.pty.reportRendererSerializerReady?.(ptyId)
        }
      })
      .catch(() => {})
  }
}
