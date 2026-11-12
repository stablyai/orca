import type {
  AgentSessionVoiceEndReason,
  AgentSessionVoiceEvent,
  AgentSessionVoiceRefusal
} from '../../../../../shared/agent-session/agent-session-voice-conversation'

// Codex's realtime call carries its events on this ordered channel, as its own voice helper offers.
const EVENTS_CHANNEL = 'oai-events'
// Without trickle ICE the offer must already hold candidates; a slow gather still sends what it has.
const ICE_GATHER_WAIT_MS = 2_000
// A brief network blip may recover; a longer one must not keep capturing with no way back.
const DISCONNECTED_GRACE_MS = 8_000
// Past Codex's own answer wait plus ICE: a call that never connects must not keep the microphone.
const CONNECT_DEADLINE_MS = 45_000
const MAX_CAPTIONS = 4

export type CodexVoiceFailure =
  | 'microphone-denied'
  | 'microphone-unavailable'
  | 'microphone-lost'
  | 'connect-timeout'
  | 'connection-lost'
  | 'provider-error'
  | Exclude<AgentSessionVoiceEndReason, 'requested' | 'error'>
  | AgentSessionVoiceRefusal

export type CodexVoiceCaption = { id: string; role: 'user' | 'assistant'; text: string }

export type CodexVoiceCallState = {
  /** `starting`: microphone and offer; `connecting`: waiting for Codex and the network. */
  phase: 'starting' | 'connecting' | 'live' | 'ended'
  muted: boolean
  speaking: 'user' | 'assistant' | null
  captions: readonly CodexVoiceCaption[]
  /** The preferred voice this chat's Codex does not offer; its default voice speaks instead. */
  unavailableVoice: string | null
  failure: { kind: CodexVoiceFailure; message?: string } | null
}

export type CodexVoiceSubscribe = (
  offerSdp: string,
  onEvent: (event: AgentSessionVoiceEvent) => void,
  onError: (error: unknown) => void,
  onClose: () => void
) => Promise<{ unsubscribe: () => void }>

export type CodexVoiceCallDeps = {
  openMicrophone: () => Promise<MediaStream>
  createPeer: () => RTCPeerConnection
  createAudio: () => HTMLAudioElement
  subscribe: CodexVoiceSubscribe
}

/** One attempt, from microphone to hang-up. Every exit runs `end` once, which releases the
 *  microphone, peer, playback and the host stream; the host stream's close stops Codex's side. */
export class CodexVoiceCall {
  private state: CodexVoiceCallState = {
    phase: 'starting',
    muted: false,
    speaking: null,
    captions: [],
    unavailableVoice: null,
    failure: null
  }
  private ended = false
  private stream: MediaStream | null = null
  private peer: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private audio: HTMLAudioElement | null = null
  private subscription: { unsubscribe: () => void } | null = null
  private disconnectedTimer: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private readonly onTrackEnded = (): void => this.end({ kind: 'microphone-lost' })
  private providerMessage: string | undefined

  constructor(
    private readonly deps: CodexVoiceCallDeps,
    private readonly onChange: (state: CodexVoiceCallState) => void
  ) {}

  get current(): CodexVoiceCallState {
    return this.state
  }

  async start(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await this.deps.openMicrophone()
    } catch (error) {
      this.end({ kind: microphoneFailure(error) })
      return
    }
    if (this.ended) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    this.stream = stream
    this.connectTimer = setTimeout(() => this.end({ kind: 'connect-timeout' }), CONNECT_DEADLINE_MS)
    try {
      const sdp = await this.offer(stream)
      if (this.ended) {
        return
      }
      this.update({ phase: 'connecting' })
      const subscription = await this.deps.subscribe(
        sdp,
        (event) => this.receive(event),
        () => this.end({ kind: 'connection-lost' }),
        () => this.end({ kind: 'connection-lost' })
      )
      if (this.ended) {
        subscription.unsubscribe()
        return
      }
      this.subscription = subscription
    } catch {
      this.end({ kind: 'connection-lost' })
    }
  }

  stop(): void {
    this.end(null)
  }

  setMuted(muted: boolean): void {
    if (this.ended) {
      return
    }
    // Disabled tracks send silence frames: the call and its usage continue while muted.
    this.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted
    })
    this.update({ muted })
  }

  private async offer(stream: MediaStream): Promise<string> {
    const peer = this.deps.createPeer()
    this.peer = peer
    for (const track of stream.getAudioTracks()) {
      // A mute pressed while the microphone was opening applies before any audio is sent.
      track.enabled = !this.state.muted
      track.addEventListener('ended', this.onTrackEnded)
      peer.addTrack(track, stream)
    }
    const channel = peer.createDataChannel(EVENTS_CHANNEL, { ordered: true })
    this.channel = channel
    channel.onmessage = (message) => this.observeChannel(message.data)
    peer.ontrack = (event) => this.play(event.streams[0] ?? new MediaStream([event.track]))
    peer.onconnectionstatechange = () => this.observeConnection(peer.connectionState)
    await peer.setLocalDescription(await peer.createOffer())
    await waitForIceGathering(peer)
    const sdp = peer.localDescription?.sdp
    if (!sdp) {
      throw new Error('voice offer has no session description')
    }
    return sdp
  }

  private receive(event: AgentSessionVoiceEvent): void {
    if (this.ended) {
      return
    }
    switch (event.type) {
      case 'answer':
        this.peer
          ?.setRemoteDescription({ type: 'answer', sdp: event.sdp })
          .catch(() => this.end({ kind: 'provider-error' }))
        return
      case 'transcript':
        this.caption({ id: event.itemId, role: event.role, text: event.text })
        return
      case 'error':
        this.providerMessage = event.message
        return
      case 'voice-unavailable':
        this.update({ unavailableVoice: event.voice })
        return
      case 'ended':
        this.end(
          event.reason === 'requested'
            ? null
            : event.reason === 'error'
              ? { kind: 'provider-error', ...this.message() }
              : { kind: event.reason, ...this.message() }
        )
        return
      case 'refused':
        this.end({ kind: event.reason })
    }
  }

  private observeConnection(state: RTCPeerConnectionState): void {
    if (this.ended) {
      return
    }
    if (state === 'connected') {
      this.clearTimer('disconnectedTimer')
      this.clearTimer('connectTimer')
      this.update({ phase: 'live' })
    } else if (state === 'disconnected') {
      this.disconnectedTimer ??= setTimeout(
        () => this.end({ kind: 'connection-lost' }),
        DISCONNECTED_GRACE_MS
      )
    } else if (state === 'failed' || state === 'closed') {
      this.end({ kind: 'connection-lost' })
    }
  }

  /** Only activity markers are read; transcripts come from Codex's own items. */
  private observeChannel(data: unknown): void {
    if (this.ended || typeof data !== 'string') {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    const type =
      typeof parsed === 'object' && parsed !== null && 'type' in parsed ? parsed.type : undefined
    if (type === 'input_audio_buffer.speech_started') {
      this.update({ speaking: 'user' })
    } else if (type === 'output_audio_buffer.started') {
      this.update({ speaking: 'assistant' })
    } else if (
      type === 'input_audio_buffer.speech_stopped' ||
      type === 'output_audio_buffer.stopped' ||
      type === 'output_audio_buffer.cleared'
    ) {
      this.update({ speaking: null })
    }
  }

  private play(remote: MediaStream): void {
    if (this.ended) {
      return
    }
    this.audio ??= this.deps.createAudio()
    this.audio.srcObject = remote
    this.audio.play().catch(() => this.end({ kind: 'provider-error' }))
  }

  private caption(next: CodexVoiceCaption): void {
    const rest = this.state.captions.filter((caption) => caption.id !== next.id)
    this.update({ captions: [...rest, next].slice(-MAX_CAPTIONS) })
  }

  private message(): { message?: string } {
    return this.providerMessage ? { message: this.providerMessage } : {}
  }

  /** Local resources go first: a failing transport must not leave the microphone open. */
  private end(failure: CodexVoiceCallState['failure']): void {
    if (this.ended) {
      return
    }
    this.ended = true
    this.clearTimer('disconnectedTimer')
    this.clearTimer('connectTimer')
    for (const track of this.stream?.getTracks() ?? []) {
      track.removeEventListener('ended', this.onTrackEnded)
      track.stop()
    }
    this.stream = null
    if (this.channel) {
      this.channel.onmessage = null
      this.channel.close()
      this.channel = null
    }
    if (this.peer) {
      this.peer.ontrack = null
      this.peer.onconnectionstatechange = null
      this.peer.close()
      this.peer = null
    }
    if (this.audio) {
      this.audio.pause()
      this.audio.srcObject = null
      this.audio = null
    }
    const subscription = this.subscription
    this.subscription = null
    try {
      subscription?.unsubscribe()
    } catch {
      // The host stream is gone either way; its close stops Codex's side when it can.
    }
    this.update({ phase: 'ended', speaking: null, failure })
  }

  private clearTimer(name: 'connectTimer' | 'disconnectedTimer'): void {
    const timer = this[name]
    if (timer !== null) {
      clearTimeout(timer)
      this[name] = null
    }
  }

  private update(patch: Partial<CodexVoiceCallState>): void {
    this.state = { ...this.state, ...patch }
    this.onChange(this.state)
  }
}

function microphoneFailure(error: unknown): CodexVoiceFailure {
  const name = error instanceof Error ? error.name : ''
  return name === 'NotAllowedError' || name === 'SecurityError'
    ? 'microphone-denied'
    : 'microphone-unavailable'
}

function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === 'complete') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = (): void => {
      if (peer.iceGatheringState === 'complete') {
        done()
      }
    }
    const timer = setTimeout(done, ICE_GATHER_WAIT_MS)
    peer.addEventListener('icegatheringstatechange', check)
  })
}
