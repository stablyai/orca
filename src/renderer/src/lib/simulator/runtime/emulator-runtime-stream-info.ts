import { EMULATOR_TUNNEL_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/emulator-runtime-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ensureRuntimeEnvironmentCompatible } from '@/runtime/rpc/compatibility/runtime-compatibility-probe'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  simulatorPreviewStreamUrl,
  type EmulatorStreamInfo
} from '@/components/emulator-pane/session/emulator-pane-types'

/**
 * A paired runtime's helper URLs name its own loopback; swap them for loopback ports here that
 * tunnel to it. Without a tunnel the pane keeps its controls but shows no picture.
 */
async function forwardEmulatorStreamInfo<T extends EmulatorStreamInfo>(
  target: RuntimeClientTarget,
  info: T | undefined
): Promise<T | undefined> {
  if (!info || target.kind === 'local') {
    return info
  }
  const capabilities = (await ensureRuntimeEnvironmentCompatible(target.environmentId))
    ?.capabilities
  const forwarded = capabilities?.includes(EMULATOR_TUNNEL_CAPABILITY)
    ? await window.api.emulator.forwardRuntimeSession({
        environmentId: target.environmentId,
        deviceUdid: info.deviceUdid,
        streamUrl: simulatorPreviewStreamUrl(info),
        wsUrl: info.wsUrl
      })
    : {}
  return { ...info, url: undefined, streamUrl: forwarded.streamUrl, wsUrl: forwarded.wsUrl }
}

/** `emulator.attach` on the workspace's runtime, with its stream URLs reachable from here. */
export async function attachEmulatorOnRuntime<TResult extends { info?: EmulatorStreamInfo }>(
  target: RuntimeClientTarget,
  params: Record<string, unknown>
): Promise<TResult> {
  const result = await callRuntimeRpc<TResult>(target, 'emulator.attach', params)
  return { ...result, info: await forwardEmulatorStreamInfo(target, result.info) }
}
