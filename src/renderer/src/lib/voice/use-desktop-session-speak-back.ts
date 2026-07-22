import { useEffect, useRef } from 'react'
import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { detectSpeakBackAnnouncement } from './desktop-speak-back-detect'
import { DesktopMeshSpeaker } from './desktop-mesh-speech'
import { prepareReplyForSpeech } from './prepare-reply-for-speech'
import { summarizeForSpeech } from './summarize-for-speech'
import { isSpeakBackEnabled, subscribeToSpeakBackEnabled } from './desktop-speak-back-store'

/**
 * Desktop speak-back: watch every agent the workspace knows about and, when one
 * finishes a turn, speak a summary of its reply through the mesh voice.
 *
 * Ported from `mobile/src/voice/use-session-speak-back.ts`. The mobile version
 * polls `worktree.ps` over RPC; the desktop renderer already holds the same
 * status in `agentStatusByPaneKey`, so this subscribes to the store instead of
 * polling — one fewer moving part and no envelope-unwrap trap.
 *
 * Mount once, near the app root. Does nothing until the titlebar SpeakBackToggle is on.
 */
export function useDesktopSessionSpeakBack(
  options: {
    hostEndpoint?: string | null
  } = {}
): void {
  const hostEndpoint = options.hostEndpoint ?? null
  const enabled = useSyncExternalStore(subscribeToSpeakBackEnabled, isSpeakBackEnabled)
  const agentStatusByPaneKey = useAppStore((state) => state.agentStatusByPaneKey)
  // Why subscribe here too: the picker writes to settings.voice.kokoroVoice and
  // the speaker must read the freshest value on every turn — same store path
  // the dictation toggle uses for VoiceSettings updates.
  const kokoroVoice =
    useAppStore((state) => state.settings?.voice?.kokoroVoice) ??
    getDefaultVoiceSettings().kokoroVoice
  const speakerRef = useRef<DesktopMeshSpeaker | null>(null)
  // Per-pane memory of the last observed working-ness, so we speak on the
  // working→done edge and not on every re-render that re-sees a 'done' row.
  const workingRef = useRef<Map<string, boolean>>(new Map())
  // Replies already spoken, so a repeated status update for the same finished
  // turn is not spoken twice.
  const spokenRef = useRef<Set<string>>(new Set())

  useEffect(() => {
    if (!enabled) {
      // Disarm: clear the working memory so re-enabling later does not replay a
      // turn that finished while the toggle was off, and stop any audio in
      // flight.
      workingRef.current.clear()
      speakerRef.current?.stop()
      return
    }
    if (!speakerRef.current) {
      speakerRef.current = new DesktopMeshSpeaker()
    }
    const speaker = speakerRef.current
    speaker.setHostEndpoint(hostEndpoint)

    for (const entry of Object.values(agentStatusByPaneKey)) {
      const wasWorking = workingRef.current.get(entry.paneKey) === true
      workingRef.current.set(entry.paneKey, entry.state === 'working')

      const announcement = detectSpeakBackAnnouncement(entry, wasWorking)
      if (!announcement || spokenRef.current.has(announcement.dedupeKey)) {
        continue
      }
      spokenRef.current.add(announcement.dedupeKey)

      void (async () => {
        // Strip collab inject / MCP awareness noise before summary or fallback
        // so a synth outage does not read board UUIDs and shape ids aloud.
        const cleaned = prepareReplyForSpeech(announcement.reply) || announcement.reply
        try {
          const summary = await summarizeForSpeech(announcement.reply, { hostEndpoint })
          await speaker.speak(summary, { voice: kokoroVoice })
        } catch {
          // A summarizer or synth outage should degrade to the cleaned reply,
          // never to silence — silence is indistinguishable from the feature
          // being broken. If even that throws, the connection banner already
          // reports real disconnects.
          try {
            await speaker.speak(cleaned.slice(0, 500), { voice: kokoroVoice })
          } catch {
            // Give up quietly; the next finished turn tries again.
          }
        }
      })()
    }
  }, [enabled, agentStatusByPaneKey, hostEndpoint, kokoroVoice])

  useEffect(
    () => () => {
      speakerRef.current?.stop()
    },
    []
  )
}
