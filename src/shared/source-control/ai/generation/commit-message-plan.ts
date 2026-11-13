import { generationArgumentText, type GenerationArgument } from './generation-argument'
import {
  textGenerationFailure,
  type TextGenerationFailureFields
} from '../../../text-generation-failure-copy'
import { findOptionOccurrence } from '../../../command-option-occurrence'
import { planAgentBinary } from '../../../agent-launch/startup/agent-command-plan'

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
import {
  taskPolicyRecipeArgs,
  codexRecipeConfigArgs,
  applySingletonOptionOverrides
} from './commit-message-recipe-options'
import type { TuiAgent } from '../../../agent-launch/catalog/tui-agent'
import {
  isDirectOpenCodeGenerationCommand,
  openCodeGenerationLauncherBoundary,
  mergeOpenCodeGenerationArgs
} from '../../../opencode-generation-command'
import { buildAntigravityGenerationInput } from '../../../antigravity-generation-stream'

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
  /** The prompt is the user's own words, not a repo task: the agent gets no tools where its CLI allows. */
  toolFree?: boolean
}

export type CommitMessagePlan<Argument = string> = {
  binary: string
  args: Argument[]
  /** Non-null when the prompt should be piped via stdin. */
  stdinPayload: string | null
  /** Execution-host-owned prompt attachment, materialized only when starting the process. */
  promptFile?: { content: string; argIndex: number }
  /** Task-owned UTF-8 policy artifacts, materialized on the execution host. */
  taskFiles?: { name: string; content: string; argIndex?: number; interpolateDirectory?: boolean }[]
  policyProbeArgs?: string[]
  /** Human-readable label used in error prefixes (e.g. "Claude failed: ..."). */
  label: string
  /** Leading command assignments, applied on the execution host. */
  env?: Record<string, string>
  outputFormat?: 'opencode-json' | 'antigravity-stream-json' | 'kimi-stream-json'
  /** Resolved native-task inputs; the receiving execution runtime owns the server. */
  openCodeTask?: { prefixArgs: string[]; runArgs: string[] }
}

export type CommitMessagePlanResult =
  | { ok: true; plan: CommitMessagePlan; localArgs: GenerationArgument[]; literalBinary?: boolean }
  | ({ ok: false } & TextGenerationFailureFields)

const DEFAULT_SINGLETON_OPTIONS: readonly (readonly string[])[] = [['--model']]
const ANTIGRAVITY_FORMAT_OPTIONS = [
  '--input-format',
  '-input-format',
  '--output-format',
  '-output-format'
]

function insertAdditionalAgentArgs(args: {
  baseArgs: GenerationArgument[]
  agentArgs: GenerationArgument[]
  promptDelivery: 'argv' | 'stdin' | 'file'
  prompt?: GenerationArgument
}): GenerationArgument[] {
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
    args.prompt !== undefined &&
    generationArgumentText(args.prompt).length > 0 &&
    args.baseArgs.at(-1) === args.prompt
  ) {
    return [...args.baseArgs.slice(0, -1), ...args.agentArgs, args.prompt]
  }
  return [...args.baseArgs, ...args.agentArgs]
}

export function planCommitMessageGeneration(
  input: CommitMessagePlanInput,
  prompt: string,
  options: { strictMcp?: boolean; legacyToolPolicy?: boolean } = {}
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
    const localArgs = insertAdditionalAgentArgs({
      baseArgs: planned.localArgs,
      agentArgs: agentArgs.args,
      promptDelivery: planned.stdinPayload === null ? 'argv' : 'stdin',
      prompt: planned.trailingPrompt
    })
    return {
      ok: true,
      localArgs,
      literalBinary: planned.literalBinary,
      plan: {
        binary: planned.binary,
        args: localArgs.map(generationArgumentText),
        stdinPayload: planned.stdinPayload,
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
    spec.promptDelivery === 'file'
      ? '@{prompt-file}'
      : spec.promptDelivery === 'argv'
        ? { value: prompt, literal: true as const }
        : ''
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
      : taskPolicyRecipeArgs(input.agentId, command.prefixArgs)
  const recipeArgs =
    input.agentId === 'antigravity'
      ? compactRecipeOptions(agentArgs.args, ANTIGRAVITY_FORMAT_OPTIONS)
      : taskPolicyRecipeArgs(input.agentId, agentArgs.args)
  const baseArgs = spec.buildArgs({
    prompt: argvPrompt,
    model: input.model,
    thinkingLevel: input.thinkingLevel,
    strictMcp: options.strictMcp,
    legacyToolPolicy: options.legacyToolPolicy,
    toolFree: input.toolFree,
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
    merged.prefixArgs.map(generationArgumentText),
    args
  )
  const formatOption =
    input.agentId === 'opencode' || input.agentId === 'opencode2'
      ? findOptionOccurrence(generationArgs.map(generationArgumentText), ['--format'], true)
      : null
  const kimiFormatOption =
    input.agentId === 'kimi'
      ? findRecipeOption(generationArgs, ['--output-format'], KIMI_VALUE_OPTIONS)
      : null
  const directOpenCode = isDirectOpenCodeGenerationCommand(
    command.binary,
    merged.prefixArgs.map(generationArgumentText)
  )
  const launcherBoundary = openCodeGenerationLauncherBoundary(
    command.binary,
    merged.nativePrefixArgs.map(generationArgumentText)
  )
  const nativePrefixArgs =
    launcherBoundary === null
      ? merged.nativePrefixArgs
      : merged.nativePrefixArgs.slice(0, launcherBoundary)
  const nativeRunOptions =
    launcherBoundary === null
      ? merged.nativePrefixOptions
      : [...merged.nativePrefixOptions, ...merged.nativePrefixArgs.slice(launcherBoundary)]
  return {
    ok: true,
    localArgs: generationArgs,
    plan: {
      binary: command.binary,
      args: generationArgs.map(generationArgumentText),
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
      ...(input.agentId === 'codex'
        ? {
            policyProbeArgs: [
              ...compactRecipeOptions(merged.prefixArgs.map(generationArgumentText), [
                '--model',
                '-m'
              ]),
              ...codexRecipeConfigArgs(merged.recipeArgs.map(generationArgumentText))
            ]
          }
        : {}),
      ...(input.agentId === 'antigravity'
        ? { policyProbeArgs: merged.prefixArgs.map(generationArgumentText) }
        : {}),
      ...(input.agentId === 'opencode' || input.agentId === 'opencode2'
        ? {
            openCodeTask: {
              prefixArgs: directOpenCode ? [] : nativePrefixArgs.map(generationArgumentText),
              runArgs: directOpenCode
                ? generationArgs.slice(1).map(generationArgumentText)
                : [
                    ...nativeRunOptions.map(generationArgumentText),
                    ...args.slice(1).map(generationArgumentText)
                  ]
            }
          }
        : {}),
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
