import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  launchDraftResolvedByTranscript,
  nativeChatLaunchDraftTurnBaseline,
  type NativeChatLaunchDraftTurnBaseline
} from './native-chat-launch-draft-resolution'

export function useNativeChatLaunchDraftSignal(args: {
  terminalTabId: string
  agent: string
  messages: NativeChatMessage[]
  /** In-flight messages may not be this session’s history; defer baseline capture as mobile does. */
  transcriptLoading?: boolean
}): { launchDraft: NativeChatLaunchDraft | null; launchDraftResolved: boolean } {
  // Keep the signal pane-agnostic so losing ownership after a split cannot strand an adopted copy.
  const launchDraft = useAppStore((s) => s.nativeChatLaunchDraftByTabId[args.terminalTabId] ?? null)
  const paneLaunchDraft = launchDraft?.agent === args.agent ? launchDraft : null
  const messages = args.messages
  const transcriptLoading = args.transcriptLoading === true
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
      (paneLaunchDraft && !transcriptLoading
        ? launchDraftResolvedByTranscript(paneLaunchDraft, messages, baseline)
        : false),
    [paneLaunchDraft, messages, baseline, transcriptLoading]
  )
  return { launchDraft: paneLaunchDraft, launchDraftResolved }
}

/** Only the owning pane adopts a seed into an empty composer; resolution clears untouched copies even after ownership ends. */
export function useNativeChatLaunchDraftAdoption(args: {
  terminalTabId: string
  agent: string
  launchDraft: NativeChatLaunchDraft | null | undefined
  launchDraftResolved: boolean
  draft: string
  setDraft: (next: string, options?: { unsaved?: boolean }) => void
  setCaret: (next: number) => void
  /** Splits remove ownership from every pane; gate pickup, never cleanup. */
  ownsTabWideLaunchDraft: boolean
}): void {
  const {
    terminalTabId,
    agent,
    launchDraft,
    launchDraftResolved,
    draft,
    setDraft,
    setCaret,
    ownsTabWideLaunchDraft
  } = args
  useEffect(() => {
    if (!launchDraft || launchDraft.agent !== agent) {
      return
    }
    if (launchDraftResolved) {
      // After a split neither pane owns the seed; the pane with the untouched copy must still clean up.
      const holdsUntouchedCopy = launchDraft.adopted && draft === launchDraft.text
      if (holdsUntouchedCopy) {
        setDraft('')
        setCaret(0)
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
    // Mark before copying so existing user text permanently declines the seed, even after clearing.
    useAppStore.getState().markNativeChatLaunchDraftAdopted(terminalTabId)
    if (draft === '') {
      // Do not persist the untouched copy; after reload its seed can no longer replace the TUI input.
      setDraft(launchDraft.text, { unsaved: true })
      setCaret(launchDraft.text.length)
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
}
