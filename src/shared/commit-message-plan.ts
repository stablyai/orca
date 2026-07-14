import {
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId
} from './commit-message-agent-spec'
import { planCustomCommand, tokenizeCustomCommandTemplate } from './commit-message-prompt'
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
  agentCommandOverride?: string
  agentArgs?: string
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

export function planAgentBinary(
  defaultBinary: string,
  commandOverride: string | undefined
): { ok: true; binary: string; prefixArgs: string[] } | { ok: false; error: string } {
  const command = commandOverride?.trim()
  if (!command) {
    return { ok: true, binary: defaultBinary, prefixArgs: [] }
  }

  const tokenized = tokenizeCustomCommandTemplate(command)
  if (!tokenized.ok) {
    return { ok: false, error: `Agent command override is invalid: ${tokenized.error}` }
  }
  const [binary, ...prefixArgs] = tokenized.tokens
  if (!binary) {
    return { ok: false, error: 'Agent command override must start with a binary name.' }
  }
  return { ok: true, binary, prefixArgs }
}

function planAdditionalAgentArgs(
  agentArgs: string | null | undefined
): { ok: true; args: string[] } | { ok: false; error: string } {
  const trimmed = agentArgs?.trim()
  if (!trimmed) {
    return { ok: true, args: [] }
  }
  const tokenized = tokenizeCustomCommandTemplate(trimmed)
  if (!tokenized.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${tokenized.error}` }
  }
  return { ok: true, args: tokenized.tokens }
}

// Why: `--model`/`-m` is a singleton flag — Codex rejects a repeated one with
// "cannot be used multiple times". When a recipe's CLI arguments set the model,
// it must override Orca's generated model in place instead of appending a second
// occurrence.
const MODEL_FLAGS = new Set(['--model', '-m'])

function readModelOverride(
  agentArgs: string[]
): { value: string; index: number; consumed: number } | null {
  for (let i = 0; i < agentArgs.length; i++) {
    const token = agentArgs[i]
    const equalsMatch = /^(?:--model|-m)=(.*)$/s.exec(token)
    if (equalsMatch) {
      return { value: equalsMatch[1], index: i, consumed: 1 }
    }
    if (MODEL_FLAGS.has(token) && i + 1 < agentArgs.length && !agentArgs[i + 1].startsWith('-')) {
      return { value: agentArgs[i + 1], index: i, consumed: 2 }
    }
  }
  return null
}

function applyModelFlagOverride(
  baseArgs: string[],
  agentArgs: string[]
): { baseArgs: string[]; agentArgs: string[] } {
  const override = readModelOverride(agentArgs)
  if (!override) {
    return { baseArgs, agentArgs }
  }
  const baseIndex = baseArgs.findIndex(
    (token, i) =>
      MODEL_FLAGS.has(token) && i + 1 < baseArgs.length && !baseArgs[i + 1].startsWith('-')
  )
  if (baseIndex === -1) {
    return { baseArgs, agentArgs }
  }
  const nextBase = [...baseArgs]
  nextBase[baseIndex + 1] = override.value
  const nextAgent = [...agentArgs]
  nextAgent.splice(override.index, override.consumed)
  return { baseArgs: nextBase, agentArgs: nextAgent }
}

function insertAdditionalAgentArgs(args: {
  baseArgs: string[]
  agentArgs: string[]
  promptDelivery: 'argv' | 'stdin'
  prompt: string
}): string[] {
  const { baseArgs, agentArgs } = applyModelFlagOverride(args.baseArgs, args.agentArgs)
  if (!agentArgs.length) {
    return baseArgs
  }
  const promptPlaceholderIndex = baseArgs.lastIndexOf('{prompt}')
  if (promptPlaceholderIndex !== -1) {
    const merged = [...baseArgs]
    merged.splice(promptPlaceholderIndex, 0, ...agentArgs)
    return merged
  }
  if (args.promptDelivery === 'argv' && args.prompt.length > 0 && baseArgs.at(-1) === args.prompt) {
    return [...baseArgs.slice(0, -1), ...agentArgs, args.prompt]
  }
  return [...baseArgs, ...agentArgs]
}

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
    const agentArgs = planAdditionalAgentArgs(input.agentArgs)
    if (!agentArgs.ok) {
      return agentArgs
    }
    return {
      ok: true,
      plan: {
        binary: planned.binary,
        args: insertAdditionalAgentArgs({
          baseArgs: planned.args,
          agentArgs: agentArgs.args,
          promptDelivery: planned.stdinPayload === null ? 'argv' : 'stdin',
          prompt
        }),
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
    if (!model.thinkingLevels && spec.modelSource !== 'dynamic') {
      return {
        ok: false,
        error: `Model "${model.label}" does not support a thinking effort level.`
      }
    }
    if (model.thinkingLevels && !model.thinkingLevels.some((l) => l.id === input.thinkingLevel)) {
      return {
        ok: false,
        error: `Thinking level "${input.thinkingLevel}" is not valid for ${model.label}.`
      }
    }
  }

  const argvPrompt = spec.promptDelivery === 'argv' ? prompt : ''
  const baseArgs = spec.buildArgs({
    prompt: argvPrompt,
    model: input.model,
    thinkingLevel: input.thinkingLevel
  })
  const agentArgs = planAdditionalAgentArgs(input.agentArgs)
  if (!agentArgs.ok) {
    return agentArgs
  }
  const args = insertAdditionalAgentArgs({
    baseArgs,
    agentArgs: agentArgs.args,
    promptDelivery: spec.promptDelivery,
    prompt: argvPrompt
  })
  const command = planAgentBinary(spec.binary, input.agentCommandOverride)
  if (!command.ok) {
    return { ok: false, error: command.error }
  }
  return {
    ok: true,
    plan: {
      binary: command.binary,
      args: [...command.prefixArgs, ...args],
      stdinPayload: spec.promptDelivery === 'stdin' ? prompt : null,
      label: spec.label
    }
  }
}
