/**
 * The renderer-owned half of a control session: microphone capture and the WebRTC peer
 * connection to OpenAI. Only SDP strings cross IPC (main performs the exchange with the
 * ephemeral credential it minted); raw audio never touches the bridge, which sidesteps
 * the contextBridge typed-array zeroing entirely.
 */
import { e2eConfig } from '@/lib/e2e-config'
import {
  classifyControlTranscriptEvent,
  type VoiceControlTranscriptLine
} from './voice-control-transcript-events'

export type VoiceControlSession = {
  localStream: MediaStream
  /** Closes the peer connection and mic tracks only — for when main already ended. */
  teardownLocal: () => void
  /** teardownLocal plus the main-process stop IPC. */
  stop: () => Promise<void>
}

export type VoiceControlSessionOptions = {
  sessionId: string
  microphoneDeviceId: string | null
  onIceFailed: () => void
  /** Mic unplugged or revoked mid-session (Bluetooth profile flips included). */
  onLocalTrackEnded: () => void
  /** Completed transcript lines from the event channel (user + coordinator). */
  onTranscript: (line: VoiceControlTranscriptLine) => void
  /** Fires when the coordinator's audio track arrives (after the SDP answer). */
  onRemoteStream: (stream: MediaStream) => void
}

const ICE_GATHER_BUDGET_MS = 5_000

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const deadline = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange)
      // Proceed with the candidates we have; a slow gather is not a failure.
      resolve()
    }, ICE_GATHER_BUDGET_MS)
    const onChange = (): void => {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(deadline)
        pc.removeEventListener('icegatheringstatechange', onChange)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', onChange)
  })
}

export async function createVoiceControlSession(
  options: VoiceControlSessionOptions
): Promise<VoiceControlSession> {
  // Why no sampleRate constraint: requesting 16kHz can yield a silent stream on macOS
  // (hardware runs at 44.1/48kHz) — same trap documented in use-audio-capture.ts.
  const localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(options.microphoneDeviceId ? { deviceId: { exact: options.microphoneDeviceId } } : {}),
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const pc = new RTCPeerConnection()
  let stopped = false

  const audio = document.createElement('audio')
  audio.autoplay = true
  pc.ontrack = (event) => {
    const remote = event.streams[0] ?? null
    audio.srcObject = remote
    if (remote && !stopped) {
      options.onRemoteStream(remote)
    }
  }

  for (const track of localStream.getTracks()) {
    track.addEventListener('ended', () => {
      if (!stopped) {
        options.onLocalTrackEnded()
      }
    })
    pc.addTrack(track, localStream)
  }

  // The provider's event channel also carries server events to us; the sideband in main
  // owns control traffic, we only read completed transcripts off it.
  const events = pc.createDataChannel('oai-events')
  events.onmessage = (message) => {
    if (typeof message.data !== 'string') {
      return
    }
    try {
      const line = classifyControlTranscriptEvent(JSON.parse(message.data))
      if (line) {
        options.onTranscript(line)
      }
    } catch {
      // A malformed frame is the sideband's problem to log; transcripts are best-effort.
    }
  }

  // Why: Playwright e2e cannot speak into a fake mic deterministically, so the
  // build-gated seam exposes the client event channel (same idiom as
  // __dictationMeterE2E in dictation-meter-store.ts).
  const exposeE2E = e2eConfig.exposeStore && typeof window !== 'undefined'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: window augmentation for a build-gated test seam; the property is written and deleted only here.
  const e2eWindow = exposeE2E ? (window as unknown as Record<string, unknown>) : null
  if (e2eWindow) {
    e2eWindow.__voiceControlE2E = {
      sendClientEvent: (event: Record<string, unknown>) => events.send(JSON.stringify(event))
    }
  }

  pc.addEventListener('iceconnectionstatechange', () => {
    if (!stopped && pc.iceConnectionState === 'failed') {
      options.onIceFailed()
    }
  })

  const teardownLocal = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    if (e2eWindow) {
      delete e2eWindow.__voiceControlE2E
    }
    pc.close()
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    audio.srcObject = null
  }

  const stop = async (): Promise<void> => {
    if (stopped) {
      return
    }
    teardownLocal()
    await window.api.voiceControl.stop(options.sessionId)
  }

  try {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await waitForIceGathering(pc)
    const offerSdp = pc.localDescription?.sdp
    if (!offerSdp) {
      throw new Error('voice_control_empty_sdp_offer')
    }
    const exchanged = await window.api.voiceControl.exchangeSdp(options.sessionId, offerSdp)
    if (!exchanged.ok) {
      throw new Error(exchanged.error)
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: exchanged.answerSdp })
  } catch (error) {
    pc.close()
    for (const track of localStream.getTracks()) {
      track.stop()
    }
    throw error
  }

  return { localStream, teardownLocal, stop }
}
