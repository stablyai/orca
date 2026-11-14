import { findOptionOccurrence } from './command-option-occurrence'
import type { CommitMessagePlan } from './source-control/ai/generation/commit-message-plan'

export function isDirectOpenCodeGenerationCommand(binary: string, prefixArgs: string[]): boolean {
  return /(?:^|[\\/])opencode2?(?:\.(?:cmd|exe))?$/i.test(binary) && !prefixArgs.includes('--')
}

/** Only these launchers expose an unambiguous executable operand. */
export function openCodeGenerationLauncherBoundary(
  binary: string,
  prefixArgs: string[]
): number | null {
  if (!/(?:^|[\\/])(?:npx|bunx)(?:\.(?:cmd|exe))?$/i.test(binary)) {
    return null
  }
  const flags = new Set([
    '-y',
    '--yes',
    '--no',
    '--no-install',
    '--ignore-existing',
    '--offline',
    '-q',
    '--quiet'
  ])
  for (let index = 0; index < prefixArgs.length; index++) {
    const token = prefixArgs[index]
    if (token === '--') {
      return /(?:^|[\\/])npx(?:\.(?:cmd|exe))?$/i.test(binary) &&
        prefixArgs[index + 1] !== undefined &&
        isDirectOpenCodeGenerationCommand(prefixArgs[index + 1], [])
        ? index + 2
        : null
    }
    if (isDirectOpenCodeGenerationCommand(token, [])) {
      return index + 1
    }
    if (flags.has(token)) {
      continue
    }
    if (token === '-p' || token === '--package') {
      if (prefixArgs[index + 1] === undefined) {
        return null
      }
      index++
      continue
    }
    if (token.startsWith('--package=')) {
      continue
    }
    return null
  }
  return null
}

export function mergeOpenCodeGenerationArgs(
  agentId: string,
  binary: string,
  prefixArgs: string[],
  args: string[]
): string[] {
  if (
    (agentId === 'opencode' || agentId === 'opencode2') &&
    isDirectOpenCodeGenerationCommand(binary, prefixArgs) &&
    args[0] === 'run'
  ) {
    return ['run', ...prefixArgs, ...args.slice(1)]
  }
  return [...prefixArgs, ...args]
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
