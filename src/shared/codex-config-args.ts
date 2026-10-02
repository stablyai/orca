import { hasFlag } from './agent-cli-flag-detection'
import { agentArgOptionTokens, removeAgentArgOption } from './agent-session-option-agent-args'

export function hasCodexConfigOverride(tokens: readonly string[], key: string): boolean {
  const optionTokens = agentArgOptionTokens(tokens)
  return optionTokens.some((token, index) => {
    const previous = optionTokens[index - 1]
    return (
      (token.startsWith(`${key}=`) && (previous === '-c' || previous === '--config')) ||
      token.startsWith(`-c${key}=`) ||
      token.startsWith(`-c=${key}=`) ||
      token.startsWith(`--config=${key}=`)
    )
  })
}

export function removeCodexConfigOverride(tokens: readonly string[], key: string): string[] {
  const result: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      result.push(...tokens.slice(index))
      break
    }
    const next = tokens[index + 1]
    if ((token === '-c' || token === '--config') && next?.startsWith(`${key}=`)) {
      index += 1
      continue
    }
    if (
      token.startsWith(`-c${key}=`) ||
      token.startsWith(`-c=${key}=`) ||
      token.startsWith(`--config=${key}=`)
    ) {
      continue
    }
    result.push(token)
  }
  return result
}

export function hasCodexEffortOverride(tokens: readonly string[]): boolean {
  return (
    hasFlag(tokens, ['--reasoning-effort']) ||
    hasCodexConfigOverride(tokens, 'model_reasoning_effort')
  )
}

export function removeCodexEffortOverride(tokens: readonly string[]): string[] {
  return removeCodexConfigOverride(
    removeAgentArgOption(tokens, ['--reasoning-effort']),
    'model_reasoning_effort'
  )
}
