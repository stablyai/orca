import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { VoiceControlSession } from './voice-control-session'
import { createVoiceControlSession } from './voice-control-session'
import { AgentSpeakingChips } from './AgentSpeakingChips'
import { VoiceControlIndicator } from './VoiceControlIndicator'
import { VoiceControlTranscriptPanel } from './VoiceControlTranscriptPanel'
import { collectVoiceScreenSnapshot } from './voice-control-screen-snapshot'
import { useVoiceControlTranscriptToasts } from './voice-control-transcript-toasts'
import {
  getVoiceControlUiState,
  publishVoiceControlAgentActivity,
  publishVoiceControlState,
  publishVoiceControlToolActivity,
  publishVoiceControlTranscript,
  publishVoiceControlTranscriptEntry,
  resetVoiceControl
} from './voice-control-store'
import {
  startVoiceControlMicMeter,
  startVoiceControlOutputMeter
} from './voice-control-level-meter'
import {
  dispatchVoiceControlAction,
  VOICE_CONTROL_ACTION_EVENT,
  type VoiceControlAction
} from './voice-control-events'

/**
 * Owns the control session lifecycle in the renderer: start/stop races (run-id guards,
 * mirroring DictationController), IPC state pushes into the control store, mic meter,
 * and unmount teardown. Renders the indicator pill.
 */
export function VoiceControlController() {
  const settings = useAppStore((s) => s.settings)
  useVoiceControlTranscriptToasts()
  const runIdRef = useRef(0)
  const sessionRef = useRef<VoiceControlSession | null>(null)
  const stopMeterRef = useRef<(() => void) | null>(null)
  const stopOutputMeterRef = useRef<(() => void) | null>(null)

  const stopControl = useCallback(async () => {
    runIdRef.current += 1
    stopMeterRef.current?.()
    stopMeterRef.current = null
    stopOutputMeterRef.current?.()
    stopOutputMeterRef.current = null
    const session = sessionRef.current
    sessionRef.current = null
    if (session) {
      await session.stop()
      return
    }
    // Why: a failed start publishes the store error with sessionId null while main
    // still parks the real session in 'error' — ask main for it before giving up.
    const sessionId =
      getVoiceControlUiState().sessionId ?? (await window.api.voiceControl.getState()).sessionId
    if (sessionId) {
      await window.api.voiceControl.stop(sessionId)
      return
    }
    // Why: failures before a main session exists (mic-denied, key-missing) never emit
    // main state events, so only a local reset lets the pill's Dismiss leave 'error'.
    if (getVoiceControlUiState().state === 'error') {
      publishVoiceControlState({ sessionId: null, state: 'idle' })
    }
  }, [])

  const startControl = useCallback(async () => {
    const currentState = getVoiceControlUiState().state
    if (currentState !== 'idle' && currentState !== 'error') {
      return
    }
    const runId = runIdRef.current + 1
    runIdRef.current = runId

    const started = await window.api.voiceControl.start()
    if (runIdRef.current !== runId) {
      if (started.ok) {
        await window.api.voiceControl.stop(started.sessionId)
      }
      return
    }
    if (!started.ok) {
      publishVoiceControlState({
        sessionId: null,
        state: 'error',
        errorKind: started.errorKind,
        error: started.error
      })
      return
    }

    try {
      const session = await createVoiceControlSession({
        sessionId: started.sessionId,
        microphoneDeviceId: settings?.voice?.microphoneDeviceId ?? null,
        onIceFailed: () => {
          publishVoiceControlState({
            sessionId: started.sessionId,
            state: 'error',
            errorKind: 'ice-failed'
          })
          void stopControl()
        },
        onLocalTrackEnded: () => {
          toast.message(
            translate(
              'auto.components.voice.control.VoiceControlController.e34835dab1',
              'Microphone disconnected. Voice control stopped.'
            )
          )
          void stopControl()
        },
        onTranscript: publishVoiceControlTranscript,
        onRemoteStream: (stream) => {
          stopOutputMeterRef.current?.()
          stopOutputMeterRef.current = startVoiceControlOutputMeter(stream)
        }
      })
      if (runIdRef.current !== runId) {
        await session.stop()
        return
      }
      sessionRef.current = session
      stopMeterRef.current = startVoiceControlMicMeter(session.localStream)
    } catch {
      if (runIdRef.current === runId && getVoiceControlUiState().state !== 'error') {
        // Main already published a classified error state when the failure was on its
        // side; this covers renderer-local failures (mic busy, empty offer).
        publishVoiceControlState({
          sessionId: started.sessionId,
          state: 'error',
          errorKind: 'unknown'
        })
      }
      await window.api.voiceControl.stop(started.sessionId)
    }
  }, [settings?.voice?.microphoneDeviceId, stopControl])

  useEffect(() => {
    const cleanupState = window.api.voiceControl.onStateChanged((event) => {
      publishVoiceControlState(event)
      if (event.state === 'error' || event.state === 'idle') {
        // Main ended the session (hangup budget, sideband loss). Tear down local audio
        // without a stop round-trip: on error it would erase the classified error state
        // the pill is showing.
        stopMeterRef.current?.()
        stopMeterRef.current = null
        stopOutputMeterRef.current?.()
        stopOutputMeterRef.current = null
        sessionRef.current?.teardownLocal()
        sessionRef.current = null
      }
    })
    const cleanupTool = window.api.voiceControl.onToolActivity((event) => {
      publishVoiceControlToolActivity(event)
    })
    const cleanupAgents = window.api.voiceControl.onAgentActivity((event) => {
      publishVoiceControlAgentActivity(event)
    })
    const cleanupTranscript = window.api.voiceControl.onTranscriptEntry((entry) => {
      publishVoiceControlTranscriptEntry(entry)
    })
    // describe_screen: main asks, this window (the session owner) answers from its stores.
    // Why ?.: a dev hot-reload can outpace the preload bundle captured at window creation —
    // a missing bridge method must degrade to no snapshot replies, not crash the overlay.
    const cleanupScreenSnapshot =
      window.api.voiceControl.onScreenSnapshotRequest?.((requestId) => {
        window.api.voiceControl.sendScreenSnapshot(requestId, collectVoiceScreenSnapshot())
      }) ?? (() => {})
    const cleanupResume = window.api.voiceControl.onSystemResume(() => {
      // Main already stopped the dead session; restart the WebRTC side from scratch.
      if (sessionRef.current || getVoiceControlUiState().state !== 'idle') {
        void stopControl().then(() => startControl())
      }
    })
    return () => {
      cleanupState()
      cleanupTool()
      cleanupAgents()
      cleanupTranscript()
      cleanupScreenSnapshot()
      cleanupResume()
    }
  }, [startControl, stopControl])

  // Why: the voice.control keybinding arrives over IPC (main-process before-input-event);
  // route it through the control bus so keybinding and UI clicks share one toggle path. The
  // controller only mounts while settings.voice.control.enabled is on, which gates the binding.
  useEffect(() => {
    return window.api.ui.onVoiceControlToggle(() => dispatchVoiceControlAction('toggle'))
  }, [])

  useEffect(() => {
    const handleControl = (event: Event): void => {
      const action: VoiceControlAction | null =
        event instanceof CustomEvent &&
        (event.detail === 'start' || event.detail === 'stop' || event.detail === 'toggle')
          ? event.detail
          : null
      if (action === 'start') {
        void startControl()
      } else if (action === 'stop') {
        void stopControl()
      } else if (
        getVoiceControlUiState().state === 'live' ||
        getVoiceControlUiState().state === 'minting'
      ) {
        void stopControl()
      } else {
        void startControl()
      }
    }
    document.addEventListener(VOICE_CONTROL_ACTION_EVENT, handleControl)
    return () => document.removeEventListener(VOICE_CONTROL_ACTION_EVENT, handleControl)
  }, [startControl, stopControl])

  // Why: the controller unmounts when the feature gate flips off mid-session; never
  // leave a live mic behind.
  useEffect(() => {
    return () => {
      runIdRef.current += 1
      stopMeterRef.current?.()
      stopOutputMeterRef.current?.()
      const session = sessionRef.current
      sessionRef.current = null
      if (session) {
        void session.stop()
      }
      resetVoiceControl()
    }
  }, [])

  return (
    <>
      <AgentSpeakingChips />
      <VoiceControlTranscriptPanel />
      <VoiceControlIndicator />
    </>
  )
}
