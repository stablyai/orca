import { relayOnlyEndpointRefusal } from '../pairing/runtime-relay-endpoint'
import type { PairedRuntimeConnection } from '../pairing/paired-runtime-connection'
import type {
  RuntimeOrchestrationEnvelope,
  RuntimeRequestGuard,
  RuntimeRequestPreparation,
  RuntimeRequestSelection,
  RuntimeRpcResponse
} from '../rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../session-graph/runtime-session-contracts'
import type { RemoteRuntimeSharedControlConnection } from './remote-runtime-shared-control-connection'
import { SharedControlBinaryChannels } from './remote-runtime-shared-control-binary-channels'
import { remoteRuntimeUnavailableError } from '../requests/remote-runtime-request-frames'
import { unshippedTestSwitchOn } from '../../app-lifecycle/unshipped-test-switch'
import { pairedRuntimeConnectionIdentity } from '../pairing/paired-runtime-connection'

/**
 * Hosts whose client carries everything on one connection: calls, every stream and their binary.
 * For such a host nothing opens a socket of its own; the one-shot, request and per-stream openers
 * hand their work to the host's control connection instead (design: one link per host).
 */
const links = new Map<string, () => RemoteRuntimeSharedControlConnection>()
// By owner: an environment id, or a test-switch control connection.
const keysByEnvironment = new Map<string, string>()
const testLinkOwnerOf = new WeakMap<RemoteRuntimeSharedControlConnection, string>()
let testLinkOwners = 0

// Test-only: direct hosts use one link too, so the paired suites run in both modes.
const ONE_LINK_TEST_SWITCH = 'ORCA_TEST_REMOTE_RUNTIME_ONE_LINK'
// Support's local off switch: every host keeps a socket per stream, as before one link.
const ONE_LINK_LOCAL_KILL = 'ORCA_DISABLE_REMOTE_RUNTIME_ONE_LINK'

function envFlag(name: string): boolean {
  return typeof process !== 'undefined' && process.env?.[name] === '1'
}

/** Never on in a shipped build, whatever its environment says. */
export function remoteRuntimeOneLinkTestSwitchOn(): boolean {
  return unshippedTestSwitchOn(ONE_LINK_TEST_SWITCH) && !envFlag(ONE_LINK_LOCAL_KILL)
}

export function remoteRuntimeOneLinkLocallyDisabled(): boolean {
  return envFlag(ONE_LINK_LOCAL_KILL)
}

function linkKey(connection: PairedRuntimeConnection): string {
  return `${connection.endpoint}\n${connection.hostPublicKeyB64}\n${pairedRuntimeConnectionIdentity(connection)}`
}

export function setRemoteRuntimeOneLink(
  environmentId: string,
  connection: PairedRuntimeConnection,
  link: (() => RemoteRuntimeSharedControlConnection) | null
): void {
  clearRemoteRuntimeOneLink(environmentId)
  if (link) {
    const key = linkKey(connection)
    links.set(key, link)
    keysByEnvironment.set(environmentId, key)
  }
}

export function clearRemoteRuntimeOneLink(environmentId: string): void {
  const key = keysByEnvironment.get(environmentId)
  if (key !== undefined) {
    keysByEnvironment.delete(environmentId)
    links.delete(key)
  }
}

/**
 * A control connection's binary channels: on when its owner asks, or, unless the owner decided,
 * under the test switch, which also makes the connection its host's one link as main would.
 */
export function controlBinaryChannels(
  control: RemoteRuntimeSharedControlConnection,
  args: {
    connection: PairedRuntimeConnection
    enabled: boolean | undefined
  } & ConstructorParameters<typeof SharedControlBinaryChannels>[0]
): SharedControlBinaryChannels | null {
  if (args.enabled === undefined && remoteRuntimeOneLinkTestSwitchOn()) {
    const owner = `control:${++testLinkOwners}`
    testLinkOwnerOf.set(control, owner)
    setRemoteRuntimeOneLink(owner, args.connection, () => control)
    return new SharedControlBinaryChannels(args)
  }
  return args.enabled ? new SharedControlBinaryChannels(args) : null
}

/** A closing control connection stops being its host's one link (test switch only). */
export function releaseControlOneLink(control: RemoteRuntimeSharedControlConnection): void {
  const owner = testLinkOwnerOf.get(control)
  if (owner !== undefined) {
    testLinkOwnerOf.delete(control)
    clearRemoteRuntimeOneLink(owner)
  }
}

export function remoteRuntimeOneLinkFor(
  connection: PairedRuntimeConnection
): RemoteRuntimeSharedControlConnection | null {
  return links.get(linkKey(connection))?.() ?? null
}

/** A one-shot call on the host's one link, with the status check or selection it asked for. */
export async function sendRemoteRuntimeRequestOnOneLink<TResult>(
  link: RemoteRuntimeSharedControlConnection,
  call: {
    method: string
    params: unknown
    timeoutMs: number
    envelope?: RuntimeOrchestrationEnvelope
    validateStatus?: (response: RuntimeRpcResponse<RuntimeStatus>) => void
    signal?: AbortSignal
    requestSelection?: RuntimeRequestSelection
    prepareRequest?: RuntimeRequestPreparation
    prepareGuard?: RuntimeRequestGuard
    responseTimeoutMs?: number
  }
): Promise<RuntimeRpcResponse<TResult>> {
  let params = call.params
  // The status and the call it vets must reach one socket, as on a socket of its own: a link that
  // reconnects between them may have reached a restarted host.
  let statusSocket: number | null = null
  if (call.validateStatus || call.requestSelection) {
    const status = await link.request<RuntimeStatus>(
      'status.get',
      undefined,
      call.timeoutMs,
      undefined,
      call.signal,
      { beforeSend: () => void (statusSocket = link.socketGeneration.peek()) }
    )
    call.validateStatus?.(status)
    if (call.requestSelection) {
      params = call.requestSelection.paramsForStatus(status.ok ? status.result : undefined)
    }
  }
  const sent = link.request<TResult>(
    call.method,
    params,
    call.timeoutMs,
    call.envelope,
    call.signal,
    {
      prepareRequest: call.prepareRequest,
      prepareGuard: call.prepareGuard,
      responseTimeoutMs: call.responseTimeoutMs,
      beforeSend: () => {
        if (statusSocket !== null && link.socketGeneration.peek() !== statusSocket) {
          throw remoteRuntimeUnavailableError('Remote runtime connection changed before sending.')
        }
        call.requestSelection?.onDispatch?.()
      }
    }
  )
  return await sent
}

/** A host paired over Relay has no address to dial: without its link, say so instead of dialing. */
export function refuseRelayOnlyHostWithoutLink(connection: PairedRuntimeConnection): void {
  const refusal = relayOnlyEndpointRefusal(connection.endpoint)
  if (refusal) {
    throw refusal
  }
}
