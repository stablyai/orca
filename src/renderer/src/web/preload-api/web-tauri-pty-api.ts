import type { PreloadApi } from '../../../../preload/api-types'
import {
  dropTauriPtyState,
  sendTauriPty,
  sendTerminalCommand,
  spawnTauriPty,
  stateFor
} from './web-tauri-pty-lifecycle'
import {
  addTauriPtyDataListener,
  addTauriPtyExitListener,
  addTauriPtyReplayListener,
  addTauriPtySpawnedListener,
  addTauriPtyWriteUnavailableListener,
  notifyTauriPtyWriteUnavailable
} from './web-tauri-pty-event-channel'
import { stopTauriPtyOnHost } from './web-tauri-pty-stop'
import { readTauriPtyCwd } from './web-tauri-pty-cwd'
import { callTauriPtyHost } from './web-tauri-pty-host'
import { writeTauriPtyInputAccepted } from './web-tauri-pty-input'

type TauriPtyApi = Pick<
  PreloadApi['pty'],
  | 'spawn'
  | 'write'
  | 'writeAccepted'
  | 'onWriteUnavailable'
  | 'resize'
  | 'claimViewport'
  | 'reportGeometry'
  | 'signal'
  | 'clearBuffer'
  | 'resetInputModes'
  | 'kill'
  | 'getCwd'
  | 'getSize'
  | 'onData'
  | 'onReplay'
  | 'onExit'
  | 'onSpawned'
>

export function createTauriPtyApi(): TauriPtyApi {
  return {
    spawn: spawnTauriPty,
    write: (id, data, inputKind) => {
      if (!sendTauriPty(id, data, inputKind)) {
        notifyTauriPtyWriteUnavailable(id)
      }
    },
    writeAccepted: async (id, data, inputKind, options) => {
      const state = stateFor(id)
      if (!state) {
        notifyTauriPtyWriteUnavailable(id)
        return false
      }
      return writeTauriPtyInputAccepted(state, data, inputKind, options)
    },
    onWriteUnavailable: (callback) => {
      return addTauriPtyWriteUnavailableListener(callback)
    },
    resize: (id, cols, rows) => {
      const state = stateFor(id)
      if (!state) {
        return
      }
      state.size = { cols, rows }
      state.stream.resize(cols, rows)
    },
    claimViewport: (id, cols, rows) => {
      const state = stateFor(id)
      if (!state) {
        return
      }
      state.size = { cols, rows }
      state.stream.claimViewport(cols, rows)
    },
    reportGeometry: (id, cols, rows) => {
      const state = stateFor(id)
      if (state) {
        state.size = { cols, rows }
      }
    },
    signal: (id, signal) => {
      const state = stateFor(id)
      if (!state) {
        return
      }
      if (signal === 'SIGWINCH') {
        state.stream.resize(state.size.cols, state.size.rows)
      } else if (signal === 'SIGINT') {
        // Why true signal first: ConPTY ignores the ETX byte the legacy interrupt send
        // writes, while the daemon signal path ends the pane like Electron.
        const legacyInterrupt = (): Promise<unknown> =>
          callTauriPtyHost(state.id, 'terminal.send', {
            terminal: state.handle,
            interrupt: true
          }).catch(() => {})
        void callTauriPtyHost<{ signal: { signaled: boolean } }>(state.id, 'terminal.signal', {
          terminal: state.handle,
          signal: 'SIGINT'
        }).then(
          (result) => (result?.signal?.signaled === true ? undefined : legacyInterrupt()),
          () => legacyInterrupt()
        )
      }
    },
    clearBuffer: (id) => sendTerminalCommand(id, 'terminal.clearBuffer'),
    resetInputModes: (id) => sendTerminalCommand(id, 'terminal.resetInputModes'),
    kill: async (id, opts) => {
      const state = stateFor(id)
      if (!state) {
        return
      }
      await stopTauriPtyOnHost(state, opts?.keepHistory === true)
      // A replacement binding may have arrived while the host stopped the old PTY.
      if (stateFor(id) !== state) {
        return
      }
      dropTauriPtyState(state)
    },
    getCwd: (id) => readTauriPtyCwd(id, stateFor),
    getSize: async (id) => stateFor(id)?.size ?? null,
    onData: addTauriPtyDataListener,
    onReplay: addTauriPtyReplayListener,
    onExit: addTauriPtyExitListener,
    onSpawned: addTauriPtySpawnedListener
  }
}
