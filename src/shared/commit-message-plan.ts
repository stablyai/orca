import { findOptionOccurrence } from './command-option-occurrence'
import { planAgentBinary } from './agent-command-plan'
export { planAgentBinary } from './agent-command-plan'
import type { CommandTemplateBackslash } from './commit-message-prompt'
import {
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId
} from './commit-message-agent-spec'
import { planCustomCommand, tokenizeCustomCommandTemplate } from './commit-message-prompt'
import type { TuiAgent } from './tui-agent'
import { mergeOpenCodeGenerationArgs } from './opencode-generation-command'

// Share pure request/prompt-to-spawn validation and argv planning between local main and SSH JSON-RPC generators.

export type CommitMessagePlanInput = {
  agentId: TuiAgent | 'custom'
  /** Default POSIX escapes; use literal backslashes only for known native-Windows execution, where they separate paths (#11375). */
  backslash?: CommandTemplateBackslash
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
  /** Leading command assignments, applied on the execution host. */
  env?: Record<string, string>
  outputFormat?: 'opencode-json'
}

export type CommitMessagePlanResult =
  | { ok: true; plan: CommitMessagePlan }
  | { ok: false; error: string }

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

const DEFAULT_SINGLETON_OPTIONS: readonly (readonly string[])[] = [['--model']]

function applyRecipeOptionOverride(args: {
  generatedArgs: string[]
  recipeArgs: string[]
  aliases: readonly string[]
}): { generatedArgs: string[]; recipeArgs: string[] } {
  const recipeOption = findOptionOccurrence(args.recipeArgs, args.aliases, true)
  const generatedOption = findOptionOccurrence(args.generatedArgs, args.aliases, false)
  if (!recipeOption || !generatedOption) {
    return { generatedArgs: args.generatedArgs, recipeArgs: args.recipeArgs }
  }

  const overrideTokens = args.recipeArgs.slice(
    recipeOption.index,
    recipeOption.index + recipeOption.consumed
  )
  return {
    generatedArgs: [
      ...args.generatedArgs.slice(0, generatedOption.index),
      ...overrideTokens,
      ...args.generatedArgs.slice(generatedOption.index + generatedOption.consumed)
    ],
    recipeArgs: [
      ...args.recipeArgs.slice(0, recipeOption.index),
      ...args.recipeArgs.slice(recipeOption.index + recipeOption.consumed)
    ]
  }
}

function removeAllOptionOccurrences(tokens: string[], aliases: readonly string[]): string[] {
  let result = tokens
  while (true) {
    const found = findOptionOccurrence(result, aliases, true)
    if (!found) {
      return result
    }
    result = [...result.slice(0, found.index), ...result.slice(found.index + found.consumed)]
  }
}

/** Keep the first user singleton occurrence so repeated flags cannot create rejected argv. */
function keepFirstOptionOccurrence(tokens: string[], aliases: readonly string[]): string[] {
  let result = tokens
  while (true) {
    const first = findOptionOccurrence(result, aliases, true)
    if (!first) {
      return result
    }
    const tail = result.slice(first.index + first.consumed)
    const duplicate = findOptionOccurrence(tail, aliases, true)
    if (!duplicate) {
      return result
    }
    const offset = first.index + first.consumed
    result = [
      ...result.slice(0, offset + duplicate.index),
      ...result.slice(offset + duplicate.index + duplicate.consumed)
    ]
  }
}

/** User recipe args outrank override prefixes, which outrank generated singleton values. */
function applySingletonOptionOverrides(args: {
  generatedArgs: string[]
  prefixArgs: string[]
  recipeArgs: string[]
  singletonOptions: readonly (readonly string[])[]
}): { generatedArgs: string[]; prefixArgs: string[]; recipeArgs: string[] } {
  let generatedArgs = args.generatedArgs
  let prefixArgs = args.prefixArgs
  let recipeArgs = args.recipeArgs

  for (const aliases of args.singletonOptions) {
    recipeArgs = keepFirstOptionOccurrence(recipeArgs, aliases)
    prefixArgs = keepFirstOptionOccurrence(prefixArgs, aliases)
    const recipeOption = findOptionOccurrence(recipeArgs, aliases, true)
    const prefixOption = findOptionOccurrence(prefixArgs, aliases, true)
    const prefixHasTerminator = prefixArgs.includes('--')
    if (recipeOption && !prefixHasTerminator) {
      prefixArgs = removeAllOptionOccurrences(prefixArgs, aliases)
    } else if (prefixOption && !prefixHasTerminator) {
      const generatedOption = findOptionOccurrence(generatedArgs, aliases, false)
      if (generatedOption) {
        generatedArgs = [
          ...generatedArgs.slice(0, generatedOption.index),
          ...generatedArgs.slice(generatedOption.index + generatedOption.consumed)
        ]
      }
      continue
    }
    const withRecipe = applyRecipeOptionOverride({ generatedArgs, recipeArgs, aliases })
    generatedArgs = withRecipe.generatedArgs
    recipeArgs = withRecipe.recipeArgs
  }

  return { generatedArgs, prefixArgs, recipeArgs }
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
  prompt: string,
  options: { strictMcp?: boolean } = {}
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
        // Custom commands lack friendly names; use the binary in error labels.
        label: planned.binary,
        ...(planned.env ? { env: planned.env } : {})
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
  const agentArgs = planAdditionalAgentArgs(input.agentArgs, input.backslash)
  if (!agentArgs.ok) {
    return agentArgs
  }
  const command = planAgentBinary(spec.binary, input.agentCommandOverride, input.backslash)
  if (!command.ok) {
    return { ok: false, error: command.error }
  }
  const baseArgs = spec.buildArgs({
    prompt: argvPrompt,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    strictMcp: options.strictMcp,
    userArgs: [...command.prefixArgs, ...agentArgs.args]
  })
  // Replace singleton values rather than stack them: yargs arrays crash CLIs such as OpenCode model.split.
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
  const generationArgs = mergeOpenCodeGenerationArgs(
    input.agentId,
    command.binary,
    merged.prefixArgs,
    args
  )
  const formatOption =
    input.agentId === 'opencode' || input.agentId === 'opencode2'
      ? findOptionOccurrence(generationArgs, ['--format'], true)
      : null
  return {
    ok: true,
    plan: {
      binary: command.binary,
      args: generationArgs,
      stdinPayload: spec.promptDelivery === 'stdin' ? prompt : null,
      label: spec.label,
      ...(formatOption?.value === 'json' ? { outputFormat: 'opencode-json' as const } : {}),
      ...(command.env ? { env: command.env } : {})
    }
  }
}
