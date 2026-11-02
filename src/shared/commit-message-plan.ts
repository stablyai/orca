import {
  textGenerationFailure,
  type TextGenerationFailureFields
} from './text-generation-failure-copy'
import { findOptionOccurrence } from './command-option-occurrence'
import { planAgentBinary } from './agent-command-plan'
export { planAgentBinary } from './agent-command-plan'
import type { CommandTemplateBackslash } from './commit-message-prompt'
import {
  getCommitMessageAgentSpec,
  getCommitMessageModel,
  isCustomAgentId
} from './commit-message-agent-spec'
import { planCustomCommand } from './commit-message-prompt'
import {
  KIMI_VALUE_OPTIONS,
  findRecipeOption,
  planAdditionalAgentArgs,
  compactRecipeOptions
} from './commit-message-generation-options'
import type { TuiAgent } from './tui-agent'
import { mergeOpenCodeGenerationArgs } from './opencode-generation-command'
import { buildAntigravityGenerationInput } from './antigravity-generation-stream'

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
  /** Execution-host-owned prompt attachment, materialized only when starting the process. */
  promptFile?: { content: string; argIndex: number }
  /** Human-readable label used in error prefixes (e.g. "Claude failed: ..."). */
  label: string
  /** Leading command assignments, applied on the execution host. */
  env?: Record<string, string>
  outputFormat?: 'opencode-json' | 'antigravity-stream-json' | 'kimi-stream-json'
}

export type CommitMessagePlanResult =
  | { ok: true; plan: CommitMessagePlan }
  | ({ ok: false } & TextGenerationFailureFields)

const DEFAULT_SINGLETON_OPTIONS: readonly (readonly string[])[] = [['--model']]
const ANTIGRAVITY_FORMAT_OPTIONS = [
  '--input-format',
  '-input-format',
  '--output-format',
  '-output-format'
]

function applyRecipeOptionOverride(args: {
  generatedArgs: string[]
  recipeArgs: string[]
  aliases: readonly string[]
  valueOptions: readonly string[]
}): { generatedArgs: string[]; recipeArgs: string[] } {
  const recipeOption = findRecipeOption(args.recipeArgs, args.aliases, args.valueOptions)
  const generatedOption = findRecipeOption(
    args.generatedArgs,
    args.aliases,
    args.valueOptions,
    0,
    false
  )
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

/** User recipe args outrank override prefixes, which outrank generated singleton values. */
function applySingletonOptionOverrides(args: {
  generatedArgs: string[]
  prefixArgs: string[]
  recipeArgs: string[]
  singletonOptions: readonly (readonly string[])[]
  valueOptions: readonly string[]
}): { generatedArgs: string[]; prefixArgs: string[]; recipeArgs: string[] } {
  let generatedArgs = args.generatedArgs
  let prefixArgs = args.prefixArgs
  let recipeArgs = args.recipeArgs

  for (const aliases of args.singletonOptions) {
    recipeArgs = compactRecipeOptions(recipeArgs, aliases, args.valueOptions, true)
    prefixArgs = compactRecipeOptions(prefixArgs, aliases, args.valueOptions, true)
    const recipeOption = findRecipeOption(recipeArgs, aliases, args.valueOptions)
    const prefixOption = findRecipeOption(prefixArgs, aliases, args.valueOptions)
    const prefixHasTerminator =
      findOptionOccurrence(prefixArgs, ['--'], false, args.valueOptions, 0, false) !== null
    if (recipeOption && !prefixHasTerminator) {
      prefixArgs = compactRecipeOptions(prefixArgs, aliases, args.valueOptions)
    } else if (prefixOption && !prefixHasTerminator) {
      const generatedOption = findRecipeOption(generatedArgs, aliases, args.valueOptions, 0, false)
      if (generatedOption) {
        generatedArgs = [
          ...generatedArgs.slice(0, generatedOption.index),
          ...generatedArgs.slice(generatedOption.index + generatedOption.consumed)
        ]
      }
      continue
    }
    const withRecipe = applyRecipeOptionOverride({
      generatedArgs,
      recipeArgs,
      aliases,
      valueOptions: args.valueOptions
    })
    generatedArgs = withRecipe.generatedArgs
    recipeArgs = withRecipe.recipeArgs
  }

  return { generatedArgs, prefixArgs, recipeArgs }
}

function insertAdditionalAgentArgs(args: {
  baseArgs: string[]
  agentArgs: string[]
  promptDelivery: 'argv' | 'stdin' | 'file'
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
      return { ok: false, ...textGenerationFailure('planCustomCommandEmpty') }
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
    return { ok: false, ...textGenerationFailure('planAgentUnsupported', { agent: input.agentId }) }
  }
  const model = getCommitMessageModel(input.agentId, input.model)
  if (!model) {
    return {
      ok: false,
      ...textGenerationFailure('planModelUnavailable', { model: input.model, label: spec.label })
    }
  }
  if (input.thinkingLevel) {
    if (!model.thinkingLevels && spec.modelSource !== 'dynamic') {
      return {
        ok: false,
        ...textGenerationFailure('planModelWithoutThinking', { model: model.label })
      }
    }
    if (model.thinkingLevels && !model.thinkingLevels.some((l) => l.id === input.thinkingLevel)) {
      return {
        ok: false,
        ...textGenerationFailure('planThinkingLevelInvalid', {
          level: input.thinkingLevel,
          model: model.label
        })
      }
    }
  }

  const argvPrompt =
    spec.promptDelivery === 'file' ? '@{prompt-file}' : spec.promptDelivery === 'argv' ? prompt : ''
  const agentArgs = planAdditionalAgentArgs(input.agentArgs, input.backslash)
  if (!agentArgs.ok) {
    return agentArgs
  }
  const command = planAgentBinary(spec.binary, input.agentCommandOverride, input.backslash)
  if (!command.ok) {
    return { ok: false, error: command.error }
  }
  const prefixArgs =
    input.agentId === 'antigravity'
      ? compactRecipeOptions(command.prefixArgs, ANTIGRAVITY_FORMAT_OPTIONS)
      : command.prefixArgs
  const recipeArgs =
    input.agentId === 'antigravity'
      ? compactRecipeOptions(agentArgs.args, ANTIGRAVITY_FORMAT_OPTIONS)
      : agentArgs.args
  const baseArgs = spec.buildArgs({
    prompt: argvPrompt,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    strictMcp: options.strictMcp,
    userArgs: [...prefixArgs, ...recipeArgs]
  })
  // Replace singleton values rather than stack them: yargs arrays crash CLIs such as OpenCode model.split.
  const merged = applySingletonOptionOverrides({
    generatedArgs: baseArgs,
    prefixArgs,
    recipeArgs,
    singletonOptions: spec.singletonOptions ?? DEFAULT_SINGLETON_OPTIONS,
    valueOptions: input.agentId === 'kimi' ? KIMI_VALUE_OPTIONS : []
  })
  const args =
    input.agentId === 'kimi'
      ? [...merged.generatedArgs, ...merged.recipeArgs]
      : insertAdditionalAgentArgs({
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
  const kimiFormatOption =
    input.agentId === 'kimi'
      ? findRecipeOption(generationArgs, ['--output-format'], KIMI_VALUE_OPTIONS)
      : null
  return {
    ok: true,
    plan: {
      binary: command.binary,
      args: generationArgs,
      stdinPayload:
        input.agentId === 'antigravity'
          ? buildAntigravityGenerationInput(prompt)
          : spec.promptDelivery === 'stdin'
            ? prompt
            : null,
      ...(spec.promptDelivery === 'file'
        ? {
            promptFile: {
              content: prompt,
              argIndex: merged.prefixArgs.length + merged.generatedArgs.length - 1
            }
          }
        : {}),
      label: spec.label,
      ...(formatOption?.value === 'json' ? { outputFormat: 'opencode-json' as const } : {}),
      ...(kimiFormatOption?.value === 'stream-json'
        ? { outputFormat: 'kimi-stream-json' as const }
        : {}),
      ...(input.agentId === 'antigravity'
        ? { outputFormat: 'antigravity-stream-json' as const }
        : {}),
      ...(command.env ? { env: command.env } : {})
    }
  }
}
