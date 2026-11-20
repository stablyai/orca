import type { LegacyRelayBridgeApi } from '../../../../preload/api/mobile/legacy-relay-bridge-api'
import type {
  LegacyRelayBridgeAttachResult,
  LegacyRelayBridgeCloseResult,
  LegacyRelayBridgedPane
} from '../../../../shared/remote-runtime/relay/legacy-relay-bridge-contract'
import { callRuntimeResult } from '../runtime/client/web-runtime-calls'
import { requireActiveEnvironmentOrNull } from '../runtime/client/web-runtime-session'
import {
  onLegacyRelayBridgedPaneData,
  onLegacyRelayBridgedPaneExit,
  onLegacyRelayBridgedPaneReplay,
  onLegacyRelayBridgedPanes
} from './web-legacy-relay-bridge-runtime-events'

export function createLegacyRelayBridgeApi(): LegacyRelayBridgeApi {
  return {
    listPanes: async () => {
      if (!requireActiveEnvironmentOrNull()) {
        return []
      }
      const { panes } = await callRuntimeResult<{ panes: LegacyRelayBridgedPane[] }>(
        'ssh.listLegacyRelayBridgedPanes'
      )
      return panes
    },
    attach: async (args) =>
      callRuntimeResult<LegacyRelayBridgeAttachResult>('ssh.attachLegacyRelayBridgedPane', {
        ptyId: args.ptyId
      }),
    write: (args) => {
      // Why fire-and-forget: Electron posts this over `send` with no reply, so the
      // transport already treats a lost keystroke as the relay's problem, not a call error.
      void callRuntimeResult('ssh.writeLegacyRelayBridgedPane', {
        ptyId: args.ptyId,
        data: args.data
      }).catch(() => {})
    },
    resize: (args) => {
      void callRuntimeResult('ssh.resizeLegacyRelayBridgedPane', {
        ptyId: args.ptyId,
        cols: args.cols,
        rows: args.rows
      }).catch(() => {})
    },
    detach: (args) => {
      void callRuntimeResult('ssh.detachLegacyRelayBridgedPane', { ptyId: args.ptyId }).catch(
        () => {}
      )
    },
    close: async (args) =>
      callRuntimeResult<LegacyRelayBridgeCloseResult>('ssh.closeLegacyRelayBridgedPane', {
        ptyId: args.ptyId
      }),
    setOutputPaused: (args) => {
      void callRuntimeResult('ssh.setLegacyRelayBridgedPaneOutputPaused', {
        ptyId: args.ptyId,
        paused: args.paused
      }).catch(() => {})
    },
    onPanes: (callback) => onLegacyRelayBridgedPanes(callback),
    onData: (callback) => onLegacyRelayBridgedPaneData(callback),
    onReplay: (callback) => onLegacyRelayBridgedPaneReplay(callback),
    onExit: (callback) => onLegacyRelayBridgedPaneExit(callback)
  }
}
