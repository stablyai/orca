import type { CommandTemplateBackslash } from './commit-message-prompt'
import {
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId
} from './commit-message-agent-spec'
import { planCustomCommand, tokenizeCustomCommandTemplate } from './commit-message-prompt'
import type { TuiAgent } from './tui-agent'

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

const DEFAULT_SINGLETON_OPTIONS: readonly (readonly string[])[] = [['--model']]

function matchesOption(token: string, aliases: readonly string[]): boolean {
  return aliases.some(
    (alias) =>
      token === alias ||
      token.startsWith(`${alias}=`) ||
      (alias.startsWith('-') &&
        !alias.startsWith('--') &&
        token.startsWith(alias) &&
        token.length > alias.length)
  )
}

function findOptionOccurrence(
  tokens: string[],
  aliases: readonly string[],
  stopAtTerminator: boolean
): { index: number; consumed: number } | null {
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (stopAtTerminator && token === '--') {
      break
    }
    if (!matchesOption(token, aliases)) {
      continue
    }
    const nextToken = tokens[index + 1]
    const consumesNext =
      aliases.includes(token) && nextToken !== undefined && !nextToken.startsWith('-')
    return { index, consumed: consumesNext ? 2 : 1 }
  }
  return null
}

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

/** Drops every occurrence after the first, so a user who types the same singleton
 *  twice in one field still gets a single flag rather than a rejected argv. */
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

/** Removes generated singleton options shadowed by user input. Recipe args
 *  outrank a command-override prefix, which outranks Orca's generated value. */
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
