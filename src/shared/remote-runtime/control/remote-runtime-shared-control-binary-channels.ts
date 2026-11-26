import {
  BinaryChannelOpcode,
  decodeBinaryChannelFrame,
  encodeBinaryChannelFrame,
  isBinaryChannelKind,
  MAX_CLIENT_CHANNEL_PAYLOAD_BYTES
} from '../protocol/runtime-binary-channel'
import type { SharedControlLogicalSubscription } from './remote-runtime-shared-control-types'

const EMPTY = new Uint8Array()
// Ended streams leave a stale owner entry until the next miss; sweep well before it matters.
const STALE_OWNER_SWEEP_AT = 64

/**
 * The client half of binary channels (`runtime-binary-channel.ts`): each stream that would have
 * had a socket of its own gets a channel number, its binary rides inside channel frames, and
 * closing it tells the host to end the stream as closing that socket did.
 */
export class SharedControlBinaryChannels {
  // Never reused on this connection, so a late frame can't reach a newer stream.
  private lastChannel = 0
  private readonly owners = new Map<number, string>()

  constructor(
    private readonly args: {
      subscriptions: Map<string, SharedControlLogicalSubscription<unknown>>
      send: (frame: Uint8Array) => boolean
    }
  ) {}

  assign(
    subscription: SharedControlLogicalSubscription<unknown>,
    stream: Pick<SharedControlLogicalSubscription<unknown>, 'channelCapabilities' | 'idlePassive'>
  ): void {
    if (this.owners.size >= STALE_OWNER_SWEEP_AT) {
      for (const [channel, requestId] of this.owners) {
        if (!this.args.subscriptions.has(requestId)) {
          this.owners.delete(channel)
        }
      }
    }
    this.lastChannel += 1
    subscription.binaryChannel = this.lastChannel
    subscription.channelCapabilities = stream.channelCapabilities
    subscription.idlePassive = stream.idlePassive
    this.owners.set(this.lastChannel, subscription.requestId)
  }

  sendData(
    subscription: SharedControlLogicalSubscription<unknown>,
    payload: Uint8Array<ArrayBufferLike>
  ): boolean {
    const channel = subscription.binaryChannel
    return (
      channel !== undefined &&
      payload.byteLength <= MAX_CLIENT_CHANNEL_PAYLOAD_BYTES &&
      subscription.sent &&
      !subscription.closed &&
      this.args.send(
        encodeBinaryChannelFrame({ opcode: BinaryChannelOpcode.Data, channel, payload })
      )
    )
  }

  /** The stream is closing here: the host ends it, as it ended a stream whose socket closed. */
  close(subscription: SharedControlLogicalSubscription<unknown> | undefined): void {
    const channel = subscription?.binaryChannel
    if (channel === undefined || !this.owners.delete(channel)) {
      return
    }
    // An unsent stream has no channel on the host: its socket closed, or it never reached it.
    if (subscription!.sent && !subscription!.closed) {
      this.args.send(
        encodeBinaryChannelFrame({ opcode: BinaryChannelOpcode.Close, channel, payload: EMPTY })
      )
    }
  }

  /** False for bytes that aren't a channel frame; a frame for an ended stream is dropped. */
  deliver(bytes: Uint8Array<ArrayBufferLike>): boolean {
    if (!isBinaryChannelKind(bytes)) {
      return false
    }
    const frame = decodeBinaryChannelFrame(bytes)
    if (!frame || frame.opcode !== BinaryChannelOpcode.Data) {
      return frame !== null
    }
    const requestId = this.owners.get(frame.channel)
    const subscription = requestId ? this.args.subscriptions.get(requestId) : undefined
    if (!subscription || subscription.closed) {
      this.owners.delete(frame.channel)
      return true
    }
    subscription.callbacks.onBinary?.(frame.payload)
    return true
  }
}
