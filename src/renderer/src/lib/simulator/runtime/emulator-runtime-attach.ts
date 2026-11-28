import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/workspace-ports-runtime-capabilities'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { isLoopbackBrowserUrl } from '../../../../../shared/browser/navigation/loopback-browser-url'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type {
  EmulatorStreamInfo,
  SimulatorDeviceRow
} from '@/components/emulator-pane/session/emulator-pane-types'
import { scrcpyDeviceIdFromStreamUrl } from '@/components/emulator-pane/streaming/emulator-scrcpy-stream-url'
import { formatSimulatorTabLabel } from '../tabs/simulator-tab-label'
import { emulatorRuntimeTarget } from './emulator-runtime-target'
import { EMULATOR_ATTACH_RPC_TIMEOUT_MS } from '../../../../../shared/emulator/emulator-attach-timeouts'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { createNonSecureContextUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'

function serverLabel(environmentId: string): string {
  return selectExecutionHostDisplayLabel(
    useAppStore.getState(),
    toRuntimeExecutionHostId(environmentId)
  )
}

/** Android on a paired server streams over scrcpy, which has no port to forward here yet. */
function serverAndroidUnsupportedError(environmentId: string): Error {
  return new Error(
    translate(
      'auto.lib.simulator.runtime.emulatorRuntimeAttach.serverAndroid',
      "Android emulators on {{host}} aren't supported yet. Pick an iOS simulator.",
      { host: serverLabel(environmentId) }
    )
  )
}

async function assertServerStreamForwardable(environmentId: string): Promise<void> {
  const supported =
    window.api?.runtimeEnvironments?.portForwards !== undefined &&
    (await runtimeEnvironmentSupportsCapability(
      environmentId,
      NETWORK_PORT_FORWARD_RUNTIME_CAPABILITY
    ).catch(() => false))
  if (!supported) {
    throw new Error(
      translate(
        'auto.lib.simulator.runtime.emulatorRuntimeAttach.updateServer',
        "Couldn't show {{host}}'s simulator here. Update Orca on {{host}} and try again.",
        { host: serverLabel(environmentId) }
      )
    )
  }
}

type AcceptedStream = {
  session: string
  environmentId: string
  /** Each forward's local port, which the pane's URLs name. */
  forwards: Map<string, number>
  deviceUdid?: string
}

/** One server workspace's attaches: the latest one started, the stream this desktop accepted, and
 *  whether this desktop started the server session that is running (so closing the pane stops it).
 *  Every cleanup goes through it, so an attach that lost the race never closes a newer stream. */
type WorkspaceStream = { generation: number; accepted?: AcceptedStream; startedHere?: string }

const workspaceStreams = new Map<string, WorkspaceStream>()
let watchingForwards = false

export const EMULATOR_STREAM_LOST_EVENT = 'orca:emulator-stream-lost'

function workspaceStream(worktreeId: string): WorkspaceStream {
  let stream = workspaceStreams.get(worktreeId)
  if (!stream) {
    stream = { generation: 0 }
    workspaceStreams.set(worktreeId, stream)
  }
  return stream
}

function endStreamSession(session: string): void {
  void window.api?.runtimeEnvironments?.portForwards?.endSession({ session }).catch(() => {})
}

/** A server disconnect closes every forward to it; the pane then shows Connect, not a frozen picture. */
function watchStreamForwards(): void {
  const api = window.api.runtimeEnvironments.portForwards
  if (watchingForwards || !api) {
    return
  }
  watchingForwards = true
  api.onChanged(({ environmentId, forwards }) => {
    const open = new Map(forwards.map((entry) => [entry.id, entry.localPort]))
    for (const [worktreeId, { accepted }] of workspaceStreams) {
      // Closed, or moved to another port in Ports: either way the pane's URLs no longer reach it.
      const moved = [...(accepted?.forwards ?? [])].some(([id, port]) => open.get(id) !== port)
      if (accepted?.environmentId === environmentId && moved) {
        releaseEmulatorStream(worktreeId, accepted.session)
        window.dispatchEvent(
          new CustomEvent(EMULATOR_STREAM_LOST_EVENT, { detail: { worktreeId } })
        )
      }
    }
  })
}

/** The server's helper URLs name its own loopback; each is rewritten to a forward of its port here,
 *  opened for this attach alone so it closes when the attach is replaced or ends. */
async function forwardServerStreamInfo(
  environmentId: string,
  worktreeId: string,
  info: EmulatorStreamInfo,
  generation: number
): Promise<EmulatorStreamInfo> {
  const api = window.api.runtimeEnvironments.portForwards!
  watchStreamForwards()
  const session = createNonSecureContextUuid()
  const forwards = new Map<string, number>()
  const forward = async (raw: string | undefined): Promise<string | undefined> => {
    // A ws: control URL names the same helper; read it as http to check its host.
    if (!raw || !isLoopbackBrowserUrl(raw.replace(/^ws/, 'http'))) {
      return undefined
    }
    const url = new URL(raw)
    const { entry } = await api.ensure({
      environmentId,
      remotePort: Number(url.port) || 80,
      label: formatSimulatorTabLabel(null),
      session
    })
    forwards.set(entry.id, entry.localPort)
    url.hostname = '127.0.0.1'
    url.port = String(entry.localPort)
    return url.toString()
  }
  const stream = workspaceStream(worktreeId)
  try {
    const [streamUrl, url, wsUrl] = await Promise.all([
      forward(info.streamUrl),
      forward(info.url),
      forward(info.wsUrl)
    ])
    if (stream.generation !== generation) {
      // A newer attach owns this workspace's stream; this result is discarded, never dialed.
      endStreamSession(session)
      return { ...info, streamUrl: undefined, url: undefined, wsUrl: undefined }
    }
    const previous = stream.accepted
    stream.accepted = { session, environmentId, forwards, deviceUdid: info.deviceUdid }
    if (previous) {
      endStreamSession(previous.session)
    }
    return { ...info, streamUrl, url, wsUrl }
  } catch (error) {
    endStreamSession(session)
    // The server already moved this workspace to another device; the old stream is gone either way.
    if (stream.generation === generation && stream.accepted?.deviceUdid !== info.deviceUdid) {
      releaseEmulatorStream(worktreeId)
    }
    throw error
  }
}

/** The stream session this desktop accepted for a server workspace, if any. */
export function acceptedEmulatorStreamSession(worktreeId: string): string | undefined {
  return workspaceStreams.get(worktreeId)?.accepted?.session
}

/** The device of the server session this desktop started (or took over), which it may stop, and the
 *  attach generation that recorded it. */
export function emulatorSessionStartedHere(
  worktreeId: string
): { device: string; generation: number } | undefined {
  const stream = workspaceStreams.get(worktreeId)
  return stream?.startedHere !== undefined
    ? { device: stream.startedHere, generation: stream.generation }
    : undefined
}

/** The server session is stopped; unless a newer attach started another meanwhile, a later close has
 *  nothing of this desktop's to stop. */
export function noteEmulatorSessionStopped(worktreeId: string, generation: number): void {
  const stream = workspaceStreams.get(worktreeId)
  if (stream?.generation === generation) {
    stream.startedHere = undefined
  }
}

/** Closes a server workspace's accepted stream; `session` limits it to that one, so a cleanup that
 *  started before a newer attach leaves the newer stream alone. */
export function releaseEmulatorStream(worktreeId: string, session?: string): void {
  const stream = workspaceStreams.get(worktreeId)
  const accepted = stream?.accepted
  if (!stream || !accepted || (session !== undefined && accepted.session !== session)) {
    return
  }
  stream.accepted = undefined
  endStreamSession(accepted.session)
}

/** Refuses a server's Android device before anything stops or boots: its picture can't reach here. */
export function assertEmulatorDeviceShownHere(
  target: RuntimeClientTarget,
  devices: readonly SimulatorDeviceRow[],
  device: string | undefined
): void {
  if (
    target.kind === 'environment' &&
    device &&
    devices.some((d) => d.backend === 'android' && (d.udid === device || d.name === device))
  ) {
    throw serverAndroidUnsupportedError(target.environmentId)
  }
}

/** `emulator.attach` on the host that owns the workspace, with stream URLs this desktop can dial. */
export async function attachEmulatorOnRuntime<TResult extends { info?: EmulatorStreamInfo }>(
  worktreeId: string,
  params: Record<string, unknown>,
  target: RuntimeClientTarget = emulatorRuntimeTarget(worktreeId)
): Promise<TResult> {
  if (target.kind === 'local') {
    return callRuntimeRpc<TResult>(target, 'emulator.attach', { ...params, worktree: worktreeId })
  }
  // Checked first, so a server that can't stream here never boots a simulator for this pane.
  await assertServerStreamForwardable(target.environmentId)
  const stream = workspaceStream(worktreeId)
  const generation = ++stream.generation
  // Only the latest attach may close the stream it replaces.
  const replaced = (deviceUdid: string | undefined): void => {
    if (stream.generation === generation && stream.accepted?.deviceUdid !== deviceUdid) {
      releaseEmulatorStream(worktreeId)
    }
  }
  const result = await callRuntimeRpc<TResult>(
    target,
    'emulator.attach',
    { ...params, backend: 'ios', worktree: worktreeId },
    // A cold simulator boot on the server takes far longer than an ordinary call.
    { timeoutMs: EMULATOR_ATTACH_RPC_TIMEOUT_MS }
  ).catch((error: unknown) => {
    // Switching devices stops the old one on the server first, so its stream is gone either way.
    if (typeof params.device === 'string') {
      replaced(params.device)
    }
    throw hasRuntimeRpcErrorCode(error, 'emulator_backend_unsupported')
      ? serverAndroidUnsupportedError(target.environmentId)
      : error
  })
  if (!result.info) {
    if (typeof params.device === 'string') {
      replaced(params.device)
    }
    return result
  }
  if (!scrcpyDeviceIdFromStreamUrl(result.info.streamUrl)) {
    // The server now runs this desktop's session, whether or not its stream reaches here.
    stream.startedHere = result.info.deviceUdid ?? result.info.device ?? ''
  }
  if (scrcpyDeviceIdFromStreamUrl(result.info.streamUrl)) {
    // A server older than the backend filter handed back Android. It may be an agent's session, so
    // it is left running.
    replaced(result.info.deviceUdid)
    throw serverAndroidUnsupportedError(target.environmentId)
  }
  return {
    ...result,
    info: await forwardServerStreamInfo(target.environmentId, worktreeId, result.info, generation)
  }
}
