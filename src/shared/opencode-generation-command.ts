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

/** Inline config outranks project config; unparseable content (JSONC) is replaced, since running without the policy is unsafe. */
export function withOpenCodeTextGenerationPolicy(content: string | undefined): string {
  let config: unknown = {}
  try {
    config = content?.trim() ? JSON.parse(content) : {}
  } catch {
    config = {}
  }
  const base = typeof config === 'object' && config !== null && !Array.isArray(config) ? config : {}
  return JSON.stringify({ ...base, permission: OPENCODE_TEXT_GENERATION_PERMISSION })
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
