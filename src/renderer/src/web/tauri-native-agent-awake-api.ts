// Tauri `agentAwake` surface: the local orcad serves `agentAwake.*` over
// runtime RPC (it owns the agent status store and host settings for the
// machine the shell runs on), the renderer forwards each verdict into Rust,
// and Rust holds the OS sleep assertion in the shell process — the same role
// Electron's `powerSaveBlocker` plays in the desktop main process. Tauri pairs
// only its own local orcad, so `subscribe`'s active environment is always the
// host whose agents this machine's blocker must track.

import type { PreloadApi } from '../../../preload/api-types'
import type { ComputerAwakeStatus } from '../../../shared/app-lifecycle/computer-awake-mode'
import { invokeNative, isTauriNativeHost, listenNative } from './tauri-native-host'
import { createWebRuntimeApi } from './preload-api/runtime/web-runtime-api'

const EVENT_AGENT_AWAKE_CHANGED = 'agentAwake:changed'

type NativeAgentAwakeApi = NonNullable<Partial<PreloadApi>['agentAwake']>

let awakeSubscriptionStarted = false

function startAwakeVerdictBridge(): void {
  if (awakeSubscriptionStarted) {
    return
  }
  awakeSubscriptionStarted = true
  void (async () => {
    try {
      await createWebRuntimeApi().subscribe(
        { method: 'agentAwake.subscribeStatus', params: null },
        (response) => {
          if (!response.ok || typeof response.result !== 'object' || response.result === null) {
            return
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: orcad emits the shared ComputerAwakeStatus shape; the object/null check above rules out non-status frames.
          const status = response.result as ComputerAwakeStatus
          void invokeNative('poc_agent_awake_set_active', {
            mode: status.mode,
            active: status.active
          }).catch(() => {})
        }
      )
    } catch {
      // An older orcad without the methods leaves the blocker off — matching
      // the web client's `active: false` fallback.
    }
  })()
}

export function createTauriNativeAgentAwakeApi(): NativeAgentAwakeApi | undefined {
  if (!isTauriNativeHost()) {
    return undefined
  }
  startAwakeVerdictBridge()
  return {
    getStatus: () => invokeNative<ComputerAwakeStatus>('poc_agent_awake_status'),
    onChanged: (callback) => listenNative<ComputerAwakeStatus>(EVENT_AGENT_AWAKE_CHANGED, callback)
  }
}
