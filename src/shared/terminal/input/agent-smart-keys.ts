import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'
import { hookRowAgentPhase } from '../../agent-status/lifecycle/agent-transitions'
import { parseNativeChatApprovalEnvelope } from '../../native-chat/input/native-chat-approval-envelope'
import { parseAskFromStatus } from '../../native-chat/input/native-chat-ask'
import { resolveNativeChatTranscriptAgent } from '../../native-chat/native-chat-agent-support'

const ESC = '\x1b'
const ARROW_UP = '\x1b[A'
const ARROW_LEFT = '\x1b[D'
const ARROW_RIGHT = '\x1b[C'
const SHIFT_TAB = '\x1b[Z'
const SHIFT_LEFT = '\x1b[1;2D'

/** The gap between a key's writes; ESC ESC in one write reads as Alt+Esc, not two presses. */
export const AGENT_SMART_KEY_STEP_MS = 120

export type AgentSmartKeyAgent = 'claude' | 'codex' | 'opencode'

export type AgentSmartKeyState = 'working' | 'permission' | 'question' | 'idle'

export type AgentSmartKeyName =
  | 'stop'
  | 'sendNow'
  | 'background'
  | 'mode'
  | 'yes'
  | 'always'
  | 'no'
  | 'cancel'
  | 'history'
  | 'rewind'
  | 'queue'
  | 'answerEdit'
  | 'confirm'
  | 'reject'

export type AgentSmartKey = {
  readonly id: string
  /** The word on the key; null when the combo itself is the label (digits, arrows). */
  readonly name: AgentSmartKeyName | null
  /** The real keys it presses. */
  readonly combo: string
  /** One terminal write each, AGENT_SMART_KEY_STEP_MS apart. */
  readonly writes: readonly string[]
  /** The prompt's accept key. */
  readonly primary?: true
}

export type AgentSmartKeySet = {
  /** The tab's own agent, e.g. openclaude, for its icon; `agent` is the TUI whose keys apply. */
  readonly agentId: string
  readonly agent: AgentSmartKeyAgent
  readonly state: AgentSmartKeyState
  readonly keys: readonly AgentSmartKey[]
}

type AgentSmartKeyRow = Pick<
  AgentStatusEntry,
  'state' | 'interrupted' | 'mainAgent' | 'interactivePrompt' | 'toolName'
>

const word = (
  name: AgentSmartKeyName,
  combo: string,
  writes: readonly string[],
  primary?: true
): AgentSmartKey => ({ id: name, name, combo, writes, ...(primary ? { primary } : {}) })

const plain = (id: string, combo: string, write: string): AgentSmartKey => ({
  id,
  name: null,
  combo,
  writes: [write]
})

// Never a key that quits the agent, such as Ctrl+C on an empty Codex or OpenCode prompt.
const STATE_KEYS: Record<
  AgentSmartKeyAgent,
  Partial<Record<Exclude<AgentSmartKeyState, 'question'>, readonly AgentSmartKey[]>>
> = {
  claude: {
    working: [
      word('stop', 'Esc', [ESC]),
      word('sendNow', '⌃X ⌃S', ['\x18\x13']),
      word('background', '⌃B', ['\x02']),
      word('mode', '⇧Tab', [SHIFT_TAB])
    ],
    permission: [
      word('yes', '1', ['1'], true),
      word('always', '2', ['2']),
      word('no', 'Esc', [ESC])
    ],
    idle: [
      word('mode', '⇧Tab', [SHIFT_TAB]),
      word('history', '↑', [ARROW_UP]),
      word('rewind', 'Esc Esc', [ESC, ESC])
    ]
  },
  codex: {
    working: [
      word('stop', 'Esc', [ESC]),
      word('queue', 'Tab', ['\t']),
      word('answerEdit', '⇧←', [SHIFT_LEFT])
    ],
    // `n` turns down only this request; Esc would also drop every queued approval.
    permission: [word('yes', 'y', ['y'], true), word('always', 'a', ['a']), word('no', 'n', ['n'])]
  },
  opencode: {
    // OpenCode asks for a second Esc before it interrupts.
    working: [word('stop', 'Esc Esc', [ESC, ESC])],
    permission: [
      plain('left', '←', ARROW_LEFT),
      plain('right', '→', ARROW_RIGHT),
      word('confirm', 'Enter', ['\r'], true),
      word('reject', 'Esc', [ESC])
    ]
  }
}

function questionKeys(row: AgentSmartKeyRow): readonly AgentSmartKey[] | null {
  const ask = parseAskFromStatus(row.interactivePrompt, row.toolName)
  // The phone can't see which question tab is open, so offer digits for the longest one.
  const optionCount = Math.min(
    9,
    Math.max(0, ...(ask?.questions ?? []).map((q) => q.options.length))
  )
  if (optionCount === 0) {
    return null
  }
  return [
    ...Array.from({ length: optionCount }, (_, index) =>
      plain(`option${index + 1}`, String(index + 1), String(index + 1))
    ),
    plain('left', '←', ARROW_LEFT),
    plain('right', '→', ARROW_RIGHT),
    word('cancel', 'Esc', [ESC])
  ]
}

/** The keys for what a terminal agent is doing now, or null when its agent or state isn't known. */
export function resolveAgentSmartKeys(
  agentId: string | null | undefined,
  row: AgentSmartKeyRow | null | undefined
): AgentSmartKeySet | null {
  const transcriptAgent = resolveNativeChatTranscriptAgent(agentId)
  if (
    !row ||
    (transcriptAgent !== 'claude' && transcriptAgent !== 'codex' && transcriptAgent !== 'opencode')
  ) {
    return null
  }
  const agent: AgentSmartKeyAgent = transcriptAgent
  const withKeys = (
    state: AgentSmartKeyState,
    keys: readonly AgentSmartKey[] | null | undefined
  ): AgentSmartKeySet | null =>
    agentId && keys && keys.length > 0 ? { agentId, agent, state, keys } : null
  const phase = hookRowAgentPhase(row)
  if (phase === 'working') {
    return withKeys('working', STATE_KEYS[agent].working)
  }
  if (phase !== 'needs-you') {
    return withKeys('idle', STATE_KEYS[agent].idle)
  }
  if (parseNativeChatApprovalEnvelope(row.interactivePrompt, agent)) {
    return withKeys('permission', STATE_KEYS[agent].permission)
  }
  return agent === 'claude' ? withKeys('question', questionKeys(row)) : null
}
