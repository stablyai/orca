import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  launchDraftResolvedByTranscript,
  nativeChatLaunchDraftTurnBaseline,
  type NativeChatLaunchDraftTurnBaseline
} from '../../../../shared/native-chat-launch-draft-resolution'
import {
  isNativeChatTranscriptUnsettled,
  type ReadState
} from './native-chat-live-session-contract'
import type { NativeChatLaunchSeed } from './native-chat-composer-types'
import {
  composerDraftWithTerminalSeed,
  useNativeChatTerminalDraftPickup,
  withoutLastLine
} from './use-native-chat-terminal-draft-pickup'

export function useNativeChatLaunchDraftSignal(args: {
  terminalTabId: string
  agent: string
  session: { messages: NativeChatMessage[]; readPhase: ReadState['phase'] }
}): {
  launchDraft: NativeChatLaunchDraft | null
  launchDraftResolved: boolean
  transcriptReady: boolean
} {
  // Keep the signal pane-agnostic so losing ownership after a split cannot strand an adopted copy.
  const launchDraft = useAppStore((s) => s.nativeChatLaunchDraftByTabId[args.terminalTabId] ?? null)
  const paneLaunchDraft = launchDraft?.agent === args.agent ? launchDraft : null
  const messages = args.session.messages
  // In-flight or awaiting messages may not be this session’s history; defer baseline capture as mobile does, and never re-offer an already-submitted prefill.
  const transcriptLoading = isNativeChatTranscriptUnsettled(args.session.readPhase)
  // Capture settled user turns to survive host clock skew; an in-flight baseline would mistake backfill for submission.
  const [heldBaseline, setHeldBaseline] = useState<{
    key: string
    baseline: NativeChatLaunchDraftTurnBaseline
  } | null>(null)
  // Key only by draft identity so reloads cannot replace the baseline and swallow the resolving turn.
  const baselineKey = paneLaunchDraft
    ? `${paneLaunchDraft.tabId} ${paneLaunchDraft.createdAt}`
    : null
  // Capture during render so the first settled transcript already resolves against its baseline.
  let held = heldBaseline
  if (baselineKey === null) {
    if (heldBaseline !== null) {
      setHeldBaseline(null)
    }
    held = null
  } else if (heldBaseline?.key !== baselineKey && !transcriptLoading) {
    held = { key: baselineKey, baseline: nativeChatLaunchDraftTurnBaseline(messages) }
    setHeldBaseline(held)
  }
  const baseline = held?.baseline ?? null
  const launchDraftResolved = useMemo(
    () =>
      paneLaunchDraft?.resolved === true ||
      // A draft read off the input line follows earlier turns; a chat send or the next read retires it.
      (paneLaunchDraft && !paneLaunchDraft.fromTerminal && !transcriptLoading
        ? launchDraftResolvedByTranscript(paneLaunchDraft, messages, baseline)
        : false),
    [paneLaunchDraft, messages, baseline, transcriptLoading]
  )
  return {
    launchDraft: paneLaunchDraft,
    launchDraftResolved,
    transcriptReady: args.session.readPhase === 'ready'
  }
}

/** Only the owning pane adopts a seed: into an empty composer, or under the composer's own text for a terminal seed. Resolution clears untouched copies even after ownership ends. */
export function useNativeChatLaunchDraftAdoption(args: {
  terminalTabId: string
  agent: string
  launchSeed: NativeChatLaunchSeed | undefined
  draft: string
  setDraft: (next: string, options?: { unsaved?: boolean }) => void
  setCaret: (next: number) => void
}): void {
  const { terminalTabId, agent, launchSeed, draft, setDraft, setCaret } = args
  const launchDraft = launchSeed?.launchDraft
  const launchDraftResolved = launchSeed?.launchDraftResolved === true
  const ownsTabWideLaunchDraft = launchSeed?.ownsTabWideLaunchDraft === true
  useEffect(() => {
    if (!launchDraft || launchDraft.agent !== agent) {
      return
    }
    if (launchDraftResolved) {
      // After a split neither pane owns the seed; the pane with the untouched copy must still clean up.
      const holdsUntouchedCopy = launchDraft.adopted && draft === launchDraft.text
      // Sent or cleared in the terminal: drop the copy shown under the composer's own text.
      const withoutTerminalCopy =
        launchDraft.fromTerminal && launchDraft.adopted
          ? withoutLastLine(draft, launchDraft.text)
          : null
      if (holdsUntouchedCopy) {
        setDraft('')
        setCaret(0)
      } else if (withoutTerminalCopy !== null) {
        setDraft(withoutTerminalCopy)
        setCaret(withoutTerminalCopy.length)
      }
      // Only the owner or its untouched copy may drop a seed; the owner may not have mirrored it yet.
      if (ownsTabWideLaunchDraft || holdsUntouchedCopy) {
        useAppStore.getState().clearNativeChatLaunchDraft(terminalTabId)
      }
      return
    }
    if (launchDraft.adopted) {
      return
    }
    // The seed belongs to the tab’s original sole pane; splits must never pick it up (#16695).
    if (!ownsTabWideLaunchDraft) {
      return
    }
    // Mark before copying so composer text that declined an Orca seed keeps declining it after clearing.
    useAppStore.getState().markNativeChatLaunchDraftAdopted(terminalTabId)
    if (draft === '' || draft === launchDraft.replacesText) {
      // Do not persist the untouched copy; after reload its seed can no longer replace the TUI input.
      setDraft(launchDraft.text, { unsaved: true })
      setCaret(launchDraft.text.length)
      return
    }
    const withTerminalText = launchDraft.fromTerminal
      ? composerDraftWithTerminalSeed(draft, launchDraft)
      : null
    if (withTerminalText !== null) {
      setDraft(withTerminalText)
      setCaret(withTerminalText.length)
    }
  }, [
    agent,
    draft,
    launchDraft,
    launchDraftResolved,
    ownsTabWideLaunchDraft,
    setCaret,
    setDraft,
    terminalTabId
  ])
  // After adoption, so a resolved draft is dropped before the pickup reads the store.
  useNativeChatTerminalDraftPickup({ terminalTabId, agent, launchSeed })
}
