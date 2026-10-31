import { useEffect, useRef } from 'react'
import { useAppStore } from '../../store'
import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { NativeChatLaunchSeed } from './native-chat-composer-types'
import { PASTED_CONTENT_PLACEHOLDER } from '../../../../shared/agent-prompt-injection'
import { IMAGE_PROMPT_MARKER } from '../../../../shared/native-chat/transcript/native-chat-image-transcript-markers'
import { canMirrorLaunchDraftToNativeChat } from '../../../../shared/native-chat/input/native-chat-launch-draft-mirrorability'

export type NativeChatTerminalDraftPickup =
  | { kind: 'seed'; draft: NativeChatLaunchDraft }
  | { kind: 'resolve'; draft: NativeChatLaunchDraft }
  | { kind: 'none' }

// Claude's `[Pasted text #1 +29 lines]` beside the shared Codex paste and image markers.
const COLLAPSED_INPUT_LABEL = new RegExp(
  [
    /\[Pasted text #\d+[^\]]*\]/.source,
    PASTED_CONTENT_PLACEHOLDER.source,
    IMAGE_PROMPT_MARKER.source
  ].join('|')
)

export function planNativeChatTerminalDraftPickup(args: {
  tabId: string
  agent: TuiAgent
  /** The tab's launch draft, unless one Orca typed still owns the input line. */
  current: NativeChatLaunchDraft | null
  /** The user's text on the agent's input line: '' when it is empty, null when unreadable. */
  terminalText: string | null
  now: number
}): NativeChatTerminalDraftPickup {
  const terminalSeed = args.current?.fromTerminal ? args.current : null
  if (args.terminalText) {
    // Same budget as launch drafts: a send must be able to clear what the composer shows.
    // A collapsed paste or image label stands for content the composer can't hold, which a send would erase.
    if (
      !canMirrorLaunchDraftToNativeChat(args.terminalText) ||
      COLLAPSED_INPUT_LABEL.test(args.terminalText)
    ) {
      // The line no longer holds the earlier seed's text, so that seed must not drive the next send's clear.
      return terminalSeed ? { kind: 'resolve', draft: terminalSeed } : { kind: 'none' }
    }
    if (terminalSeed?.text === args.terminalText) {
      return { kind: 'none' }
    }
    return {
      kind: 'seed',
      draft: {
        tabId: args.tabId,
        agent: args.agent,
        text: args.terminalText,
        createdAt: args.now,
        fromTerminal: true,
        ...(terminalSeed?.adopted ? { replacesText: terminalSeed.text } : {})
      }
    }
  }
  // Sent or cleared in the terminal since the last pickup.
  return terminalSeed && args.terminalText === ''
    ? { kind: 'resolve', draft: terminalSeed }
    : { kind: 'none' }
}

/** `draft` without `line` as its last line, or null when it doesn't end with it. */
export function withoutLastLine(draft: string, line: string): string | null {
  return draft.endsWith(`\n${line}`) ? draft.slice(0, -line.length - 1) : null
}

/** A send replaces the terminal text, so a composer holding its own text shows it underneath; null leaves the composer as is. */
export function composerDraftWithTerminalSeed(
  draft: string,
  seed: Pick<NativeChatLaunchDraft, 'text' | 'replacesText'>
): string | null {
  const kept = (seed.replacesText ? withoutLastLine(draft, seed.replacesText) : null) ?? draft
  // Whole lines, so a short draft that is only a word of the composer text still shows.
  if (`\n${kept}\n`.includes(`\n${seed.text}\n`)) {
    return kept === draft ? null : kept
  }
  return `${kept}\n${seed.text}`
}

/** Seed text left unsent on the agent's input line as the tab's launch draft, so the composer shows it and a send replaces it (#29775). */
export function useNativeChatTerminalDraftPickup(args: {
  terminalTabId: string
  agent: string
  launchSeed: NativeChatLaunchSeed | undefined
}): void {
  const { terminalTabId, agent, launchSeed } = args
  const launchDraft = launchSeed?.launchDraft ?? null
  const launchDraftResolved = launchSeed?.launchDraftResolved === true
  const transcriptReady = launchSeed?.transcriptReady === true
  const ownsTabWideLaunchDraft = launchSeed?.ownsTabWideLaunchDraft === true
  const readTerminalDraft = launchSeed?.readTerminalDraft
  const pickedUpRef = useRef(false)
  const waitedForOrcaDraftRef = useRef(false)
  useEffect(() => {
    // Once per chat-view entry: a later read could catch a chat send's own body mid-paste.
    if (pickedUpRef.current) {
      return
    }
    const orcaDraft = launchDraft && !launchDraft.fromTerminal ? launchDraft : null
    const orcaDraftResolved = orcaDraft !== null && launchDraftResolved
    // Whether a draft Orca typed was already sent is only known from a ready transcript.
    if (orcaDraft && !orcaDraftResolved && !transcriptReady) {
      waitedForOrcaDraftRef.current = true
      return
    }
    pickedUpRef.current = true
    // An unresolved draft Orca typed owns the line, and one gone unresolved was taken by a chat send whose clear may not have landed.
    // The seed is keyed by tab, so only its owning pane may read one (#16695).
    if (
      (orcaDraft && !orcaDraftResolved) ||
      (waitedForOrcaDraftRef.current && !orcaDraft) ||
      !ownsTabWideLaunchDraft ||
      !readTerminalDraft ||
      !isTuiAgent(agent)
    ) {
      return
    }
    const state = useAppStore.getState()
    const plan = planNativeChatTerminalDraftPickup({
      tabId: terminalTabId,
      agent,
      current: state.nativeChatLaunchDraftByTabId[terminalTabId] ?? null,
      terminalText: readTerminalDraft(),
      now: Date.now()
    })
    if (plan.kind === 'seed') {
      state.seedNativeChatLaunchDraft(plan.draft)
    } else if (plan.kind === 'resolve') {
      state.resolveNativeChatLaunchDraft(terminalTabId, plan.draft)
    }
  }, [
    agent,
    launchDraft,
    launchDraftResolved,
    ownsTabWideLaunchDraft,
    readTerminalDraft,
    terminalTabId,
    transcriptReady
  ])
}
