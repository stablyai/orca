import type { WebSocket } from 'ws'
import type { E2EEChannel, E2EEChannelOptions } from '../../../src/main/runtime/rpc/e2ee-channel'
import type { MobileE2EEV2ClientSession } from '../../../mobile/src/transport/mobile-e2ee-v2-client-session'
import type { MobileE2EEV2PhysicalChannel } from '../../../mobile/src/transport/mobile-e2ee-v2-physical-channel'
import type { MobileRelayRpcStreams } from '../../../mobile/src/transport/mobile-relay-rpc-streams'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  type ReleaseCheckout
} from './release-checkout'
import { WORKING_TREE, type HostWire, type WireCodec } from './versioned-terminal-wire'

export type MobileWireSession = Pick<MobileE2EEV2ClientSession, keyof MobileE2EEV2ClientSession>
export type MobileWirePhysicalChannel = Pick<
  MobileE2EEV2PhysicalChannel,
  keyof MobileE2EEV2PhysicalChannel
>
export type MobileWireStreams = Pick<
  MobileRelayRpcStreams,
  'subscribe' | 'handleResponse' | 'handleBinary' | 'clear'
> &
  Partial<
    Pick<
      MobileRelayRpcStreams,
      | 'supportsTerminalStreamInput'
      | 'sendTerminalStreamInput'
      | 'getTerminalStreamInputFailure'
      | 'recoverTerminalStreamInput'
      | 'cancelTerminalStreamInput'
      | 'fenceTerminalStreamInput'
    >
  >
export type MobileWireHostChannel = Pick<
  E2EEChannel,
  'onMessage' | 'onBinaryMessage' | 'handleRawMessage' | 'destroy'
>

type PhysicalChannelOptions = Omit<
  ConstructorParameters<typeof MobileE2EEV2PhysicalChannel>[0],
  'session'
> & { session: MobileWireSession }
type HostChannelOptions = Omit<E2EEChannelOptions, 'onReady'> & {
  onReady: (
    channel: MobileWireHostChannel,
    device: Parameters<E2EEChannelOptions['onReady']>[1]
  ) => void
}

export type MobileTerminalWireBuild = HostWire & {
  label: string
  revision: string
  codec: WireCodec
  E2EEChannel: new (socket: WebSocket, options: HostChannelOptions) => MobileWireHostChannel
  MobileE2EEV2ClientSession: {
    create: (args: Parameters<typeof MobileE2EEV2ClientSession.create>[0]) => MobileWireSession
  }
  MobileE2EEV2PhysicalChannel: new (options: PhysicalChannelOptions) => MobileWirePhysicalChannel
  MobileRelayRpcStreams: new (
    options: ConstructorParameters<typeof MobileRelayRpcStreams>[0]
  ) => MobileWireStreams
}

/** Every endpoint and transitive relative import stays anchored to its own build. */
export async function loadMobileTerminalWireBuild(ref: string): Promise<MobileTerminalWireBuild> {
  const checkout: ReleaseCheckout | null =
    ref === WORKING_TREE ? null : await materializeReleaseCheckout(ref)
  const load = (path: string): Promise<Record<string, unknown>> =>
    checkout
      ? importReleaseCheckoutModule(checkout, path)
      : import(/* @vite-ignore */ `../../../${path}`)
  const [codec, dispatcher, methods, host, session, channel, streams] = await Promise.all([
    load('src/shared/terminal-stream-protocol.ts'),
    load('src/main/runtime/rpc/dispatcher.ts'),
    load('src/main/runtime/rpc/methods/terminal.ts'),
    load('src/main/runtime/rpc/e2ee-channel.ts'),
    load('mobile/src/transport/mobile-e2ee-v2-client-session.ts'),
    load('mobile/src/transport/mobile-e2ee-v2-physical-channel.ts'),
    load('mobile/src/transport/mobile-relay-rpc-streams.ts')
  ])
  return {
    label: checkout?.ref ?? WORKING_TREE,
    revision: checkout?.commit ?? WORKING_TREE,
    codec: codec as WireCodec,
    RpcDispatcher: dispatcher.RpcDispatcher as HostWire['RpcDispatcher'],
    TERMINAL_METHODS: methods.TERMINAL_METHODS as unknown[],
    E2EEChannel: host.E2EEChannel as MobileTerminalWireBuild['E2EEChannel'],
    MobileE2EEV2ClientSession:
      session.MobileE2EEV2ClientSession as MobileTerminalWireBuild['MobileE2EEV2ClientSession'],
    MobileE2EEV2PhysicalChannel:
      channel.MobileE2EEV2PhysicalChannel as MobileTerminalWireBuild['MobileE2EEV2PhysicalChannel'],
    MobileRelayRpcStreams:
      streams.MobileRelayRpcStreams as MobileTerminalWireBuild['MobileRelayRpcStreams']
  }
}
