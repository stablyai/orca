import {
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId
} from './commit-message-agent-spec'
import { planCustomCommand } from './commit-message-prompt'
import type { TuiAgent } from './types'

// Why: planning is a pure transformation from "user request + prompt text"
// into "spawn-ready binary + argv". Keeping it in shared lets both the local
// generator (main process) and the SSH provider (which delegates to the
// relay over JSON-RPC) reuse the exact same validation and arg-building
// logic without duplicating the spec/model/thinking checks.

export type CommitMessagePlanInput = {
  agentId: TuiAgent | 'custom'
  model: string
  thinkingLevel?: string
  customAgentCommand?: string
}

export type CommitMessagePlan = {
  binary: string
  args: string[]
  /** Non-null when the prompt should be piped via stdin. */
  stdinPayload: string | null
  /** Human-readable label used in error prefixes (e.g. "Claude failed: ..."). */
  label: string
}

export type CommitMessagePlanResult =
  | { ok: true; plan: CommitMessagePlan }
  | { ok: false; error: string }

export function planCommitMessageGeneration(
  input: CommitMessagePlanInput,
  prompt: string
): CommitMessagePlanResult {
  if (isCustomAgentId(input.agentId)) {
    const command = input.customAgentCommand?.trim() ?? ''
    if (!command) {
      return {
        ok: false,
        error: 'Custom command is empty. Add one in Settings → Git → AI Commit Messages.'
      }
    }
    const planned = planCustomCommand(command, prompt)
    if (!planned.ok) {
      return { ok: false, error: planned.error }
    }
    return {
      ok: true,
      plan: {
        binary: planned.binary,
        args: planned.args,
        stdinPayload: planned.stdinPayload,
        // Why: a custom command has no friendly name, so the binary doubles
        // as the label in error prefixes ("ollama failed: ...").
        label: planned.binary
      }
    }
  }

  const spec = getCommitMessageAgentSpec(input.agentId)
  if (!spec) {
    return { ok: false, error: `Agent "${input.agentId}" does not support AI commit messages.` }
  }
  const model = getCommitMessageModel(input.agentId, input.model)
  if (!model) {
    return { ok: false, error: `Model "${input.model}" is not available for ${spec.label}.` }
  }
  if (input.thinkingLevel) {
    if (!model.thinkingLevels) {
      return {
        ok: false,
        error: `Model "${model.label}" does not support a thinking effort level.`
      }
    }
    if (!model.thinkingLevels.some((l) => l.id === input.thinkingLevel)) {
      return {
        ok: false,
        error: `Thinking level "${input.thinkingLevel}" is not valid for ${model.label}.`
      }
    }
  }

  const argvPrompt = spec.promptDelivery === 'argv' ? prompt : ''
  const args = spec.buildArgs({
    prompt: argvPrompt,
    model: input.model,
    thinkingLevel: input.thinkingLevel
  })
  return {
    ok: true,
    plan: {
      binary: spec.binary,
      args,
      stdinPayload: spec.promptDelivery === 'stdin' ? prompt : null,
      label: spec.label
    }
  }
}
