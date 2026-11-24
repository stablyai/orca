import {
  AGENT_TUI_CLEAR_MAX_LINES,
  countAgentTuiInputLines,
  buildAgentTuiClearInputForText
} from '../../../../../shared/agent-launch/startup/agent-tui-input-clear'

export type NativeChatLaunchDraftSendPlan =
  /** Input line holds a stale injected draft — replace it, clearing every line. */
  | { kind: 'replace-draft'; clearInput: string; seededText: string }
  /** No injected draft is parked on the line; keep the ordinary send path. */
  | { kind: 'default' }

/** Visual wrapping loses logical lines, so replace from the composer copy rather than trusting a screen match. */
export function planNativeChatLaunchDraftSend(args: {
  /** Text Orca injected into the TUI line, or null when nothing is parked there. */
  seededText: string | null | undefined
}): NativeChatLaunchDraftSendPlan {
  const seededText = args.seededText
  if (!seededText || seededText.trim() === '') {
    return { kind: 'default' }
  }
  return {
    kind: 'replace-draft',
    clearInput: buildAgentTuiClearInputForText(seededText),
    seededText
  }
}

type NativeChatInputLineSendOptions = {
  clearInput: string | null
  readInputLine: () => string | null | undefined
}

const tooTallToClear = (text: string | null | undefined): boolean =>
  text != null && countAgentTuiInputLines(text) > AGENT_TUI_CLEAR_MAX_LINES

/** Size the clear to what the agent's input line holds. */
export function resolveNativeChatInputLineSend(
  /** The user's text on the agent's input line: '' when it is empty, null when unreadable. */
  readInputLine: () => string | null | undefined
): NativeChatInputLineSendOptions {
  const draft = readInputLine()
  if (tooTallToClear(draft)) {
    return { clearInput: null, readInputLine }
  }
  return { clearInput: buildAgentTuiClearInputForText(draft), readInputLine }
}

/** Replace a parked launch draft, otherwise clear whatever the input line holds. */
export function resolveNativeChatLaunchDraftSend(args: {
  launchDraft: { agent: string; text: string } | null | undefined
  launchDraftResolved: boolean
  agent: string
  readInputLine: () => string | null | undefined
}): { plan: NativeChatLaunchDraftSendPlan; sendOptions: NativeChatInputLineSendOptions } {
  const { launchDraft, launchDraftResolved, agent, readInputLine } = args
  // A resolved prefill no longer owns TUI input; clearing again could erase the user’s replacement.
  const seededText =
    launchDraft && launchDraft.agent === agent && !launchDraftResolved ? launchDraft.text : null
  const plan = planNativeChatLaunchDraftSend({ seededText })
  const sendOptions = resolveNativeChatInputLineSend(readInputLine)
  if (plan.kind !== 'replace-draft' || sendOptions.clearInput === null) {
    return { plan, sendOptions }
  }
  if (tooTallToClear(seededText)) {
    return { plan, sendOptions: { clearInput: null, readInputLine } }
  }
  return { plan, sendOptions: { clearInput: plan.clearInput, readInputLine } }
}
