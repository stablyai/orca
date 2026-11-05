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

/**
 * OpenCode applies the last matching rule and evaluates agent rules after top-level ones, so only rules on the build
 * agent itself beat project agent config and native `permissions`. Inline config outranks project config, but within
 * it `agents` and `mode` entries replace `agent` entries, so theirs are dropped. Malformed content is replaced, since
 * running without the policy is unsafe.
 */
export function withOpenCodeTextGenerationPolicy(content: string | undefined): string {
  const errors: ParseError[] = []
  const config: unknown = parse(content ?? '', errors, { allowTrailingComma: true })
  const base = isRecord(config) && errors.length === 0 ? config : {}
  const agentMaps = Object.fromEntries(
    ['agent', 'agents', 'mode'].flatMap((key) => {
      const map = base[key]
      return isRecord(map) ? [[key, { ...map, build: undefined }]] : []
    })
  )
  return JSON.stringify({
    ...base,
    ...agentMaps,
    permission: OPENCODE_TEXT_GENERATION_PERMISSION,
    agent: { ...agentMaps.agent, build: { permission: OPENCODE_TEXT_GENERATION_PERMISSION } }
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function openCodeTextGenerationEnv(
  agentId: string,
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  return agentId === 'opencode' || agentId === 'opencode2'
    ? {
        ...env,
        OPENCODE_CONFIG_CONTENT: withOpenCodeTextGenerationPolicy(env?.OPENCODE_CONFIG_CONTENT)
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
