import { useEffect, useRef } from 'react'
import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { detectSpeakBackAnnouncement } from './desktop-speak-back-detect'
import { DesktopMeshSpeaker } from './desktop-mesh-speech'
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
 * Mount once, near the app root. Does nothing until the toolbar toggle is on.
 */
export function useDesktopSessionSpeakBack(): void {
  const enabled = useSyncExternalStore(subscribeToSpeakBackEnabled, isSpeakBackEnabled)
  const agentStatusByPaneKey = useAppStore((state) => state.agentStatusByPaneKey)

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

    for (const entry of Object.values(agentStatusByPaneKey)) {
      const wasWorking = workingRef.current.get(entry.paneKey) === true
      workingRef.current.set(entry.paneKey, entry.state === 'working')

      const announcement = detectSpeakBackAnnouncement(entry, wasWorking)
      if (!announcement || spokenRef.current.has(announcement.dedupeKey)) {
        continue
      }
      spokenRef.current.add(announcement.dedupeKey)

      void (async () => {
        try {
          await speaker.speak(await summarizeForSpeech(announcement.reply))
        } catch {
          // A summarizer or synth outage should degrade to the raw reply, never
          // to silence — silence is indistinguishable from the feature being
          // broken. If even that throws, the connection banner already reports
          // real disconnects.
          try {
            await speaker.speak(announcement.reply)
          } catch {
            // Give up quietly; the next finished turn tries again.
          }
        }
      })()
    }
  }, [enabled, agentStatusByPaneKey])

  useEffect(
    () => () => {
      speakerRef.current?.stop()
    },
    []
  )
}
