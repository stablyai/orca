import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { AGENT_SESSION_CODEX_VOICE_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/agent-session-runtime-capabilities'
import { runtimeEnvironmentSupportsCapabilities } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { subscribeStructuredAgentSessionVoice } from '@/runtime/native-chat/requests/structured-agent-session-subscriptions'
import { openMicrophoneCaptureStream } from '@/components/dictation/microphone-devices'
import { CodexVoiceCall, type CodexVoiceCallState } from './codex-voice-call'
import { noteCodexVoiceSource } from './codex-voice-catalog'
import { AGENT_SESSION_VOICE_NAME_PATTERN } from '../../../../../shared/agent-session/agent-session-voice-conversation'

export type NativeChatCodexVoice = {
  /** `unavailable`: this chat's host has no voice relay. */
  availability: 'checking' | 'available' | 'unavailable'
  /** Dictation holds the microphone; voice waits for it to finish. */
  dictating: boolean
  /** Null before the first call and after a clean hang-up. */
  call: CodexVoiceCallState | null
  start: () => void
  stop: () => void
  setMuted: (muted: boolean) => void
  dismiss: () => void
}

export const NativeChatCodexVoiceContext = createContext<NativeChatCodexVoice | null>(null)

export function useNativeChatCodexVoiceControl(): NativeChatCodexVoice | null {
  return useContext(NativeChatCodexVoiceContext)
}

// An unreachable host is not a "no": ask again, since its recovery keeps the same environment.
const UNREACHABLE_PROBE_RETRY_MS = 30_000

function useVoiceRelayAvailability(
  environmentId: string | null
): NativeChatCodexVoice['availability'] {
  const [remote, setRemote] = useState<{
    id: string
    supported: boolean
    unreachable: boolean
  } | null>(null)
  const [probe, setProbe] = useState(0)
  useEffect(() => {
    if (environmentId === null) {
      return
    }
    let current = true
    void runtimeEnvironmentSupportsCapabilities(environmentId, [
      AGENT_SESSION_CODEX_VOICE_RUNTIME_CAPABILITY
    ]).then(
      ([supported]) => {
        if (current) {
          setRemote({ id: environmentId, supported: supported === true, unreachable: false })
        }
      },
      () => {
        if (current) {
          setRemote({ id: environmentId, supported: false, unreachable: true })
        }
      }
    )
    return () => {
      current = false
    }
  }, [environmentId, probe])
  const unreachable = remote?.id === environmentId && remote.unreachable
  useEffect(() => {
    if (!unreachable) {
      return
    }
    const retry = setTimeout(() => setProbe((count) => count + 1), UNREACHABLE_PROBE_RETRY_MS)
    return () => clearTimeout(retry)
  }, [unreachable, probe])
  if (environmentId === null) {
    return 'available'
  }
  return remote?.id !== environmentId ? 'checking' : remote.supported ? 'available' : 'unavailable'
}

/** Codex chats only. A call ends when the chat is hidden, switched or unmounted; it never restarts
 *  on its own. */
export function useNativeChatCodexVoice(args: {
  sessionId: string
  target: RuntimeClientTarget
  agent: string
  visible: boolean
}): NativeChatCodexVoice | null {
  const { sessionId, target, visible } = args
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const availability = useVoiceRelayAvailability(environmentId)
  const dictationState = useAppStore((store) => store.dictationState)
  const dictating = dictationState === 'starting' || dictationState === 'listening'
  const callRef = useRef<CodexVoiceCall | null>(null)
  const [call, setCall] = useState<CodexVoiceCallState | null>(null)

  const stop = useCallback(() => {
    callRef.current?.stop()
  }, [])

  const start = useCallback(() => {
    if (callRef.current && callRef.current.current.phase !== 'ended') {
      return
    }
    const voice = useAppStore.getState().settings?.voice
    const callTarget: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    // A hand-edited value the host would refuse falls back to Codex's default instead.
    const codexVoice =
      voice?.codexVoice && AGENT_SESSION_VOICE_NAME_PATTERN.test(voice.codexVoice)
        ? voice.codexVoice
        : undefined
    const next = new CodexVoiceCall(
      {
        openMicrophone: async () =>
          (
            await openMicrophoneCaptureStream({
              preferredDeviceId: voice?.microphoneDeviceId ?? null,
              preferredDeviceLabel: voice?.microphoneDeviceLabel ?? null,
              getUserMedia: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
              enumerateDevices: () => navigator.mediaDevices.enumerateDevices()
            })
          ).stream,
        createPeer: () => new RTCPeerConnection(),
        createAudio: () => new Audio(),
        subscribe: (offerSdp, onEvent, onError, onClose) =>
          subscribeStructuredAgentSessionVoice(
            callTarget,
            { sessionId, offerSdp, ...(codexVoice ? { voice: codexVoice } : {}) },
            onEvent,
            onError,
            onClose
          )
      },
      (state) => {
        if (callRef.current === next) {
          setCall(state.phase === 'ended' && state.failure === null ? null : state)
        }
      }
    )
    callRef.current = next
    setCall(next.current)
    void next.start()
  }, [sessionId, environmentId])

  // Settings lists voices from the Codex chat shown last, and asks again when it opens.
  const listVoices = args.agent === 'codex' && visible && availability === 'available'
  useEffect(() => {
    if (listVoices) {
      noteCodexVoiceSource({
        target: environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
        sessionId
      })
    }
  }, [listVoices, sessionId, environmentId])

  // Dictation started from anywhere (its shortcut included) takes the microphone from the call.
  useEffect(() => {
    if (dictating) {
      callRef.current?.stop()
    }
  }, [dictating])

  // Switching chats or runtimes, hiding the chat, or unmounting ends the call.
  useEffect(() => {
    if (!visible) {
      callRef.current?.stop()
    }
    return () => {
      callRef.current?.stop()
      callRef.current = null
      setCall(null)
    }
  }, [sessionId, environmentId, visible])

  const setMuted = useCallback((muted: boolean) => callRef.current?.setMuted(muted), [])
  const dismiss = useCallback(() => {
    if (callRef.current?.current.phase === 'ended') {
      callRef.current = null
      setCall(null)
    }
  }, [])

  const control = useMemo(
    () => ({ availability, dictating, call, start, stop, setMuted, dismiss }),
    [availability, dictating, call, start, stop, setMuted, dismiss]
  )
  return args.agent === 'codex' ? control : null
}
