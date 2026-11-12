import type { AgentSessionVoiceEvent } from '../../../../../shared/agent-session/agent-session-voice-conversation'

/** A microphone track whose stop and external end are observable. */
export class FakeVoiceTrack {
  readonly kind = 'audio'
  enabled = true
  stopped = false
  private readonly endedListeners = new Set<() => void>()

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') {
      this.endedListeners.add(listener)
    }
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'ended') {
      this.endedListeners.delete(listener)
    }
  }

  stop(): void {
    this.stopped = true
  }

  /** The device was unplugged or access revoked. */
  endFromOutside(): void {
    for (const listener of this.endedListeners) {
      listener()
    }
  }

  get listening(): boolean {
    return this.endedListeners.size > 0
  }
}

export function fakeVoiceStream(track: FakeVoiceTrack): MediaStream {
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: CodexVoiceCall reads only getTracks/getAudioTracks, and the tracks implement what it uses.
  return stream as unknown as MediaStream
}

export class FakeVoicePeer {
  closed = false
  connectionState: RTCPeerConnectionState = 'new'
  readonly iceGatheringState = 'complete'
  localDescription: { type: string; sdp: string } | null = null
  readonly remoteAnswers: string[] = []
  readonly channel: { onmessage: unknown; closed: boolean; close: () => void } = {
    onmessage: null,
    closed: false,
    close: () => {}
  }
  ontrack: unknown = null
  onconnectionstatechange: (() => void) | null = null

  constructor() {
    this.channel.close = () => {
      this.channel.closed = true
    }
  }

  addTrack(): void {}
  createDataChannel() {
    return this.channel
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 synthetic offer' }
  }
  async setLocalDescription(description: { type: string; sdp: string }): Promise<void> {
    this.localDescription = description
  }
  async setRemoteDescription(description: { sdp: string }): Promise<void> {
    this.remoteAnswers.push(description.sdp)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {
    this.closed = true
  }

  moveTo(state: RTCPeerConnectionState): void {
    this.connectionState = state
    this.onconnectionstatechange?.()
  }

  asPeer(): RTCPeerConnection {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: implements every RTCPeerConnection member CodexVoiceCall touches.
    return this as unknown as RTCPeerConnection
  }
}

export class FakeVoiceAudio {
  paused = false
  srcObject: unknown = null
  async play(): Promise<void> {}
  pause(): void {
    this.paused = true
  }
  asAudio(): HTMLAudioElement {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: CodexVoiceCall only plays, pauses and sets srcObject.
    return this as unknown as HTMLAudioElement
  }
}

/** The host stream: tests push its frames and see whether it was released. */
export class FakeVoiceHostStream {
  unsubscribed = false
  offerSdp: string | null = null
  private onEvent: ((event: AgentSessionVoiceEvent) => void) | null = null

  readonly subscribe = async (
    offerSdp: string,
    onEvent: (event: AgentSessionVoiceEvent) => void
  ): Promise<{ unsubscribe: () => void }> => {
    this.offerSdp = offerSdp
    this.onEvent = onEvent
    return {
      unsubscribe: () => {
        this.unsubscribed = true
      }
    }
  }

  push(event: AgentSessionVoiceEvent): void {
    this.onEvent?.(event)
  }
}
