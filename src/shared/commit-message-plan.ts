import type { CommandTemplateBackslash } from './commit-message-prompt'
import {
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId
} from './commit-message-agent-spec'
import { planCustomCommand, tokenizeCustomCommandTemplate } from './commit-message-prompt'
import type { TuiAgent } from './tui-agent'
import {
  applySingletonOptionOverrides,
  DEFAULT_SINGLETON_OPTIONS,
  removeAllOptionOccurrences
} from './commit-message-singleton-options'

// Why: planning is a pure transformation from "user request + prompt text"
// into "spawn-ready binary + argv". Keeping it in shared lets both the local
// generator (main process) and the SSH provider (which delegates to the
// relay over JSON-RPC) reuse the exact same validation and arg-building
// logic without duplicating the spec/model/thinking checks.

export type CommitMessagePlanInput = {
  agentId: TuiAgent | 'custom'
  /** How to read `\` in the user's command override / args / custom command.
   *  Defaults to POSIX escaping; pass `'literal'` only when the command is known
   *  to run on native Windows, where `\` is the path separator (#11375). */
  backslash?: CommandTemplateBackslash
  model: string
  thinkingLevel?: string
  useAgentDefaultModel?: boolean
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
  commandOverride: string | undefined,
  backslash: CommandTemplateBackslash = 'escape'
): { ok: true; binary: string; prefixArgs: string[] } | { ok: false; error: string } {
  const command = commandOverride?.trim()
  if (!command) {
    return { ok: true, binary: defaultBinary, prefixArgs: [] }
  }

  const tokenized = tokenizeCustomCommandTemplate(command, backslash)
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
  agentArgs: string | null | undefined,
  backslash: CommandTemplateBackslash = 'escape'
): { ok: true; args: string[] } | { ok: false; error: string } {
  const trimmed = agentArgs?.trim()
  if (!trimmed) {
    return { ok: true, args: [] }
  }
  const tokenized = tokenizeCustomCommandTemplate(trimmed, backslash)
  if (!tokenized.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${tokenized.error}` }
  }
  return { ok: true, args: tokenized.tokens }
}

function insertAdditionalAgentArgs(args: {
  baseArgs: string[]
  agentArgs: string[]
  promptDelivery: 'argv' | 'stdin'
  prompt: string
}): string[] {
  if (!args.agentArgs.length) {
    return args.baseArgs
  }
  const promptPlaceholderIndex = args.baseArgs.lastIndexOf('{prompt}')
  if (promptPlaceholderIndex !== -1) {
    const merged = [...args.baseArgs]
    merged.splice(promptPlaceholderIndex, 0, ...args.agentArgs)
    return merged
  }
  if (
    args.promptDelivery === 'argv' &&
    args.prompt.length > 0 &&
    args.baseArgs.at(-1) === args.prompt
  ) {
    return [...args.baseArgs.slice(0, -1), ...args.agentArgs, args.prompt]
  }
  return [...args.baseArgs, ...args.agentArgs]
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
    const planned = planCustomCommand(command, prompt, input.backslash)
    if (!planned.ok) {
      return { ok: false, error: planned.error }
    }
    const agentArgs = planAdditionalAgentArgs(input.agentArgs, input.backslash)
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
  const model = input.useAgentDefaultModel
    ? undefined
    : getCommitMessageModel(input.agentId, input.model)
  if (!input.useAgentDefaultModel && !model) {
    return { ok: false, error: `Model "${input.model}" is not available for ${spec.label}.` }
  }
  if (input.thinkingLevel && model) {
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
  const builtArgs = spec.buildArgs({
    prompt: argvPrompt,
    model: input.model,
    thinkingLevel: input.useAgentDefaultModel ? undefined : input.thinkingLevel
  })
  const modelOptionAliases = spec.singletonOptions?.[0] ?? DEFAULT_SINGLETON_OPTIONS[0]
  const baseArgs = input.useAgentDefaultModel
    ? removeAllOptionOccurrences(builtArgs, modelOptionAliases)
    : builtArgs
  const agentArgs = planAdditionalAgentArgs(input.agentArgs, input.backslash)
  if (!agentArgs.ok) {
    return agentArgs
  }
  const command = planAgentBinary(spec.binary, input.agentCommandOverride, input.backslash)
  if (!command.ok) {
    return { ok: false, error: command.error }
  }
  // Why: repeating a singleton flag makes yargs-based CLIs parse it as an array and
  // crash (OpenCode's `model.split('/')`). User values replace Orca's, never stack.
  const merged = applySingletonOptionOverrides({
    generatedArgs: baseArgs,
    prefixArgs: command.prefixArgs,
    recipeArgs: agentArgs.args,
    singletonOptions: spec.singletonOptions ?? DEFAULT_SINGLETON_OPTIONS
  })
  const args = insertAdditionalAgentArgs({
    baseArgs: merged.generatedArgs,
    agentArgs: merged.recipeArgs,
    promptDelivery: spec.promptDelivery,
    prompt: argvPrompt
  })
  return {
    ok: true,
    plan: {
      binary: command.binary,
      args: [...merged.prefixArgs, ...args],
      stdinPayload: spec.promptDelivery === 'stdin' ? prompt : null,
      label: spec.label
    }
  }
}
