// What entering chat view does with text the user left on the agent's input line, so the
// composer shows it and a send replaces it. Pure so the rule stays unit-testable without React.

import type { NativeChatLaunchDraft } from '@/lib/native-chat-launch-prompt'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  detectTerminalComposerDraft,
  hasTerminalComposerPlaceholder,
  type TerminalCursorContext
} from '../../../../shared/terminal-composer-draft'
import { agentInputLineCleared } from './native-chat-launch-draft-send'

/** The user's own text on the agent's input line: '' when the line is observably empty, null
 *  when no input line can be read. */
export function agentInputLineText(
  context: TerminalCursorContext | null,
  screen: string | null
): string | null {
  // Dim text right of the cursor is the agent's placeholder or suggestion, never the user's input.
  const typed = context
    ? detectTerminalComposerDraft({ ...context, rawAfterCursor: context.afterCursor })
    : null
  if (typed) {
    return typed.text
  }
  const onlyHint =
    detectTerminalComposerDraft(context) !== null || hasTerminalComposerPlaceholder(context)
  return onlyHint || agentInputLineCleared(screen) ? '' : null
}

export type NativeChatTerminalDraftPickup =
  | { kind: 'seed'; draft: NativeChatLaunchDraft }
  /** The input line is empty now, so the seed read off it earlier is gone TUI-side. */
  | { kind: 'resolve'; draft: NativeChatLaunchDraft }
  | { kind: 'none' }

export function planNativeChatTerminalDraftPickup(args: {
  tabId: string
  agent: TuiAgent
  /** The tab's current launch draft. */
  current: NativeChatLaunchDraft | null
  /** `agentInputLineText` of the agent's input line. */
  terminalText: string | null
  now: number
}): NativeChatTerminalDraftPickup {
  const { current, terminalText } = args
  // Orca's own launch draft already owns the line and its lifecycle.
  if (current && !current.fromTerminal) {
    return { kind: 'none' }
  }
  if (terminalText) {
    if (current?.text === terminalText) {
      return { kind: 'none' }
    }
    return {
      kind: 'seed',
      draft: {
        tabId: args.tabId,
        agent: args.agent,
        text: terminalText,
        createdAt: args.now,
        fromTerminal: true,
        ...(current?.adopted ? { replacesText: current.text } : {})
      }
    }
  }
  return current && terminalText === '' ? { kind: 'resolve', draft: current } : { kind: 'none' }
}
