import { isAdaLHeadlessOneShotCommand } from './adal-headless-command'
import { isAnteHeadlessOneShotCommand } from './ante-headless-command'
import { isClaudeHeadlessOneShotCommand } from './claude-headless-command'
import type { TuiAgent } from './types'

export function isHeadlessOneShotAgentCommand(agent: TuiAgent, tokens: readonly string[]): boolean {
  if (agent === 'claude') {
    return isClaudeHeadlessOneShotCommand(tokens)
  }
  if (agent === 'ante') {
    return isAnteHeadlessOneShotCommand(tokens)
  }
  return agent === 'adal' && isAdaLHeadlessOneShotCommand(tokens)
}

type AgentCommandRecognition = { agent: TuiAgent } | null

export function filterHeadlessOneShotAgentCommand<T extends AgentCommandRecognition>(
  recognition: T,
  tokens: readonly string[]
): T | null {
  if (recognition && isHeadlessOneShotAgentCommand(recognition.agent, tokens)) {
    return null
  }
  return recognition
}
