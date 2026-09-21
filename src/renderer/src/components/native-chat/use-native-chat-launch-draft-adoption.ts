import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import {
  launchDraftResolvedByTranscript,
  nativeChatLaunchDraftTurnBaseline,
  type NativeChatLaunchDraftTurnBaseline
} from './native-chat-launch-draft-resolution'

/** Select the pane's launch draft and whether the transcript has resolved it. */
export function useNativeChatLaunchDraftSignal(args: {
  terminalTabId: string
  agent: string
  messages: NativeChatMessage[]
  /** The transcript read is still in flight, so `messages` is not yet the
   *  session's real history. Same gate mobile's drafts hook uses. */
  transcriptLoading?: boolean
}): { launchDraft: NativeChatLaunchDraft | null; launchDraftResolved: boolean } {
  // Deliberately pane-agnostic: pane ownership gates the composer *write* in
  // useNativeChatLaunchDraftAdoption. Nulling the seed here would also strand a
  // copy an owning pane already mirrored, since the adoption effect early-returns.
  const launchDraft = useAppStore((s) => s.nativeChatLaunchDraftByTabId[args.terminalTabId] ?? null)
  const paneLaunchDraft = launchDraft?.agent === args.agent ? launchDraft : null
  const messages = args.messages
  const transcriptLoading = args.transcriptLoading === true
  // Timestamp-free backstop: snapshot the transcript's user turns the first time
  // this draft is seen, so a host clock skewed past the slack still resolves.
  // Deferred until the read settles — a baseline taken on the empty in-flight
  // list would be exceeded by the backfill itself, dropping a draft the user
  // never saw.
  const [heldBaseline, setHeldBaseline] = useState<{
    key: string
    baseline: NativeChatLaunchDraftTurnBaseline
  } | null>(null)
  // Keyed on draft identity alone: a reload mid-draft must not discard a
  // baseline already taken from a settled transcript — re-taking it from the
  // fuller list would swallow the very user turn that resolves the draft.
  const baselineKey = paneLaunchDraft
    ? `${paneLaunchDraft.tabId} ${paneLaunchDraft.createdAt}`
    : null
  // Adjusted during render, not in an effect: the same render that first sees a
  // settled transcript must already resolve against the captured baseline.
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

/**
 * Adopt launch-time draft context (e.g. a linked issue URL prefilled into the
 * TUI input buffer) into the chat composer, and drop it again once the
 * transcript shows the TUI-side copy was resolved (submitted or cleared).
 *
 * State machine per seeded draft:
 * - unadopted + not the owning pane → ignore (the seed is keyed by tab; #16695)
 * - unadopted + composer empty      → copy text into the composer, mark adopted
 * - unadopted + composer in use     → mark adopted without copying (never stomp)
 * - resolved by transcript          → clear the composer copy while it is still
 *                                     the untouched seed text, and drop the seed
 */
export function useNativeChatLaunchDraftAdoption(args: {
  terminalTabId: string
  agent: string
  launchDraft: NativeChatLaunchDraft | null | undefined
  launchDraftResolved: boolean
  draft: string
  setDraft: (next: string) => void
  setCaret: (next: number) => void
  /** This pane is the tab-wide evidence's owner (`nativeChatLeafOwnsTabWideEvidence`).
   *  Splitting drops it for every pane, so it gates pickup, never cleanup. */
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
      // Cleanup must survive a split: ownership is gone for both panes by then,
      // so the pane still holding the untouched copy is the one that cleans up.
      const holdsUntouchedCopy = launchDraft.adopted && draft === launchDraft.text
      if (holdsUntouchedCopy) {
        setDraft('')
        setCaret(0)
      }
      // A pane that neither owns the seed nor holds its copy has no standing to
      // drop it — the owning pane may not have mirrored it yet.
      if (ownsTabWideLaunchDraft || holdsUntouchedCopy) {
        useAppStore.getState().clearNativeChatLaunchDraft(terminalTabId)
      }
      return
    }
    if (launchDraft.adopted) {
      return
    }
    // #16695: the seed describes the tab's original sole pane, so once a split
    // exists no pane may mirror it into a composer.
    if (!ownsTabWideLaunchDraft) {
      return
    }
    // Mark adopted before copying so a composer that already holds user text
    // declines the seed permanently instead of resurrecting it on a later clear.
    useAppStore.getState().markNativeChatLaunchDraftAdopted(terminalTabId)
    if (draft === '') {
      setDraft(launchDraft.text)
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
