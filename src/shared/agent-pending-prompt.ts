import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import { hookRowAgentPhase } from './agent-transitions'
import { parseAskFromStatus } from './native-chat-ask'
import { buildAskAnswerKeys, buildCodexAskAnswerKeys } from './native-chat-ask-answer'
import { parseNativeChatApprovalEnvelope } from './native-chat-approval-envelope'
import {
  resolveNativeChatTranscriptAgent,
  shouldStepNativeChatAskAnswer
} from './native-chat-agent-support'

export type PendingPromptOption = { id: string; label: string; description?: string }

/**
 * What a hook-reported terminal agent is waiting on, as one outside the window can answer it.
 * Readers must treat a kind they do not know as `unsupported`: more kinds (free text, several
 * questions) may come.
 */
export type PendingPrompt =
  | {
      kind: 'approval'
      promptId: string
      tool: string
      summary?: string
      options: PendingPromptOption[]
    }
  | {
      kind: 'question'
      promptId: string
      question: string
      header?: string
      options: PendingPromptOption[]
    }
  /** The agent is waiting on something only Orca's own views can answer. */
  | { kind: 'unsupported'; promptId: string }

type PromptRow = Pick<
  AgentStatusIpcPayload,
  'state' | 'interrupted' | 'mainAgent' | 'interactivePrompt' | 'toolName'
>

/** The row's prompt and the bytes each offered option writes; null while the agent is not waiting. */
export function readAgentPromptAnswers(
  row: PromptRow,
  agent: string,
  promptId: string,
  /** Whether this agent's status hooks and answer keys are known; without them only Orca can answer. */
  answerable: boolean
): { prompt: PendingPrompt; keysByOption: ReadonlyMap<string, string> } | null {
  if (hookRowAgentPhase(row) !== 'needs-you') {
    return null
  }
  const unsupported = {
    prompt: { kind: 'unsupported' as const, promptId },
    keysByOption: new Map()
  }
  if (!answerable || resolveNativeChatTranscriptAgent(agent) === null) {
    return unsupported
  }
  const approval = parseNativeChatApprovalEnvelope(row.interactivePrompt, agent)
  if (approval) {
    return {
      prompt: {
        kind: 'approval',
        promptId,
        tool: approval.tool,
        ...(approval.summary ? { summary: approval.summary } : {}),
        options: [
          { id: 'allow_once', label: 'Allow once' },
          { id: 'reject_once', label: 'Reject' }
        ]
      },
      keysByOption: new Map([
        ['allow_once', approval.allowSend],
        ['reject_once', approval.denySend]
      ])
    }
  }
  const ask = parseAskFromStatus(row.interactivePrompt, row.toolName)
  const question = ask?.questions.length === 1 ? ask.questions[0] : undefined
  if (!ask || !question || question.multiSelect || ask.replyAsMessage) {
    return unsupported
  }
  if (!shouldStepNativeChatAskAnswer(agent)) {
    return unsupported
  }
  const keysByOption = new Map<string, string>()
  const options = question.options.flatMap((option, index): PendingPromptOption[] => {
    const selections = [{ indices: [index] }]
    const groups =
      resolveNativeChatTranscriptAgent(agent) === 'codex'
        ? buildCodexAskAnswerKeys(ask, selections)
        : buildAskAnswerKeys(ask, selections)
    // A pick that takes more than one keystroke needs the paced writer only Orca's views run.
    const only = groups.length === 1 ? groups[0] : undefined
    if (!only || !('raw' in only)) {
      return []
    }
    const id = String(index + 1)
    keysByOption.set(id, only.raw)
    return [
      {
        id,
        label: option.label,
        ...(option.description ? { description: option.description } : {})
      }
    ]
  })
  if (options.length === 0 || options.length !== question.options.length) {
    return unsupported
  }
  return {
    prompt: {
      kind: 'question',
      promptId,
      question: question.question,
      ...(question.header ? { header: question.header } : {}),
      options
    },
    keysByOption
  }
}
