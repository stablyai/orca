import {
  AGENT_TUI_CLEAR_MAX_LINES,
  countAgentTuiInputLines,
  buildAgentTuiClearInputForText
} from '../../../../shared/agent-launch/startup/agent-tui-input-clear'

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

/** Select replacement clearing and optional confirmation for the normal send paths. */
export function resolveNativeChatLaunchDraftSend(args: {
  launchDraft: { agent: string; text: string } | null | undefined
  launchDraftResolved: boolean
  agent: string
  /** The user's text on the agent's input line: '' when it is empty, null when unreadable. */
  readInputLine: () => string | null | undefined
}): {
  plan: NativeChatLaunchDraftSendPlan
  sendOptions: { clearInput: string | null; confirmCleared?: () => boolean }
} {
  const { launchDraft, launchDraftResolved, agent, readInputLine } = args
  // A resolved prefill no longer owns TUI input; clearing again could erase the user’s replacement.
  const seededText =
    launchDraft && launchDraft.agent === agent && !launchDraftResolved ? launchDraft.text : null
  const plan = planNativeChatLaunchDraftSend({ seededText })
  const draft = readInputLine()
  if (
    [draft, seededText].some(
      (text) => text != null && countAgentTuiInputLines(text) > AGENT_TUI_CLEAR_MAX_LINES
    )
  ) {
    return { plan, sendOptions: { clearInput: null } }
  }
  if (plan.kind !== 'replace-draft') {
    return { plan, sendOptions: { clearInput: buildAgentTuiClearInputForText(draft) } }
  }
  return {
    plan,
    sendOptions: {
      clearInput: plan.clearInput,
      // A dim placeholder or suggestion is not residue; only typed text is.
      confirmCleared: () => readInputLine() === ''
    }
  }
}
