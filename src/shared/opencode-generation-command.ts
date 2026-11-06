import { parse, type ParseError } from 'jsonc-parser'
import { findOptionOccurrence } from './command-option-occurrence'
import type { CommitMessagePlan } from './source-control/ai/generation/commit-message-plan'

export function mergeOpenCodeGenerationArgs(
  agentId: string,
  binary: string,
  prefixArgs: string[],
  args: string[]
): string[] {
  if (
    (agentId === 'opencode' || agentId === 'opencode2') &&
    /(?:^|[\\/])opencode2?(?:\.(?:cmd|exe))?$/i.test(binary) &&
    args[0] === 'run' &&
    !prefixArgs.includes('--')
  ) {
    return ['run', ...prefixArgs, ...args.slice(1)]
  }
  return [...prefixArgs, ...args]
}

// Prompts carry their context, but saved templates may name repo files to read (matches Claude's text-generation tools).
const OPENCODE_TEXT_GENERATION_PERMISSION = {
  '*': 'deny',
  read: 'allow',
  grep: 'allow',
  glob: 'allow',
  list: 'allow'
}

/** The agent a run selects; the policy must sit on this agent, whichever one recipe args chose. */
export function openCodeSelectedAgent(args: readonly string[]): string {
  return findOptionOccurrence(args, ['--agent'], true)?.value ?? 'build'
}

/**
 * OpenCode applies the last matching rule and evaluates agent rules after top-level ones, so only rules on the selected
 * agent itself beat project agent config and native `permissions`. Inline config outranks project config, but within
 * it `agents` and `mode` entries replace `agent` entries, so theirs are dropped, keeping only the model and variant the
 * run may rely on. Malformed content is replaced, since running without the policy is unsafe.
 */
export function withOpenCodeTextGenerationPolicy(
  content: string | undefined,
  agent = 'build'
): string {
  const errors: ParseError[] = []
  const config: unknown = parse(content ?? '', errors, { allowTrailingComma: true })
  const base = isRecord(config) && errors.length === 0 ? config : {}
  const entries = ['agents', 'mode', 'agent'].flatMap((key) => {
    const map = base[key]
    return isRecord(map) ? [[key, map] as const] : []
  })
  const selection = entries
    .map(([, map]) => map[agent])
    .filter(isRecord)
    .map(legacyAgentModel)
    .find((entry) => entry.model)
  const agentMaps = Object.fromEntries(
    entries.map(([key, map]) => [key, { ...map, [agent]: undefined }])
  )
  return JSON.stringify({
    ...base,
    ...agentMaps,
    permission: OPENCODE_TEXT_GENERATION_PERMISSION,
    agent: {
      ...agentMaps.agent,
      [agent]: {
        ...selection,
        permission: OPENCODE_TEXT_GENERATION_PERMISSION
      }
    }
  })
}

/** The `agent` map ignores native selections (`{providerID, model, variant}`, `provider/model#variant`), so convert them. */
function legacyAgentModel({ model, variant }: Record<string, unknown>): {
  model?: string
  variant?: string
} {
  const [id, nativeVariant] =
    typeof model === 'string'
      ? model.split('#')
      : isRecord(model) && typeof model.providerID === 'string' && typeof model.model === 'string'
        ? [`${model.providerID}/${model.model}`, model.variant]
        : []
  const selected = nativeVariant ?? variant
  return {
    ...(id ? { model: id } : {}),
    ...(typeof selected === 'string' ? { variant: selected } : {})
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function openCodeTextGenerationEnv(
  agentId: string,
  env: Record<string, string> | undefined,
  args: readonly string[]
): Record<string, string> | undefined {
  return agentId === 'opencode' || agentId === 'opencode2'
    ? {
        ...env,
        OPENCODE_CONFIG_CONTENT: withOpenCodeTextGenerationPolicy(
          env?.OPENCODE_CONFIG_CONTENT,
          openCodeSelectedAgent(args)
        )
      }
    : env
}

export function openCodeVariantRetryPlan(
  plan: CommitMessagePlan,
  stderr: string
): CommitMessagePlan | null {
  // Retry only an argv rejection, which happens before a model turn starts.
  if (!stderr.includes('Unrecognized flag: --variant in command opencode run')) {
    return null
  }
  const variant = findOptionOccurrence(plan.args, ['--variant'], true)
  const model = findOptionOccurrence(plan.args, ['--model', '-m'], true)
  if (!variant?.value || !model?.value) {
    return null
  }
  const args = [...plan.args]
  const replacement = `${model.value.split('#')[0]}#${variant.value}`
  if (model.consumed === 2) {
    args[model.index + 1] = replacement
  } else {
    const token = args[model.index]
    args[model.index] = `${token.slice(0, token.length - model.value.length)}${replacement}`
  }
  args.splice(variant.index, variant.consumed)
  return { ...plan, args }
}
