import type { TuiAgent } from '../../../../shared/tui-agent'
import type { HostChatAnswer } from '@/lib/new-tab-agent-menu-rows'

// Why module scope: every tab group's + menu on one workspace host shares what that host said.
const answersByOwner = new Map<string, Map<TuiAgent, HostChatAnswer>>()
const listeners = new Set<() => void>()
let version = 0
const MAX_OWNERS = 32

export function readHostChatAnswer(ownerKey: string, agent: TuiAgent): HostChatAnswer | undefined {
  return answersByOwner.get(ownerKey)?.get(agent)
}

export function recordHostChatAnswer(
  ownerKey: string,
  agent: TuiAgent,
  answer: HostChatAnswer
): void {
  const answers = answersByOwner.get(ownerKey) ?? new Map<TuiAgent, HostChatAnswer>()
  answersByOwner.delete(ownerKey)
  answersByOwner.set(ownerKey, answers.set(agent, answer))
  for (const stale of [...answersByOwner.keys()].slice(0, -MAX_OWNERS)) {
    answersByOwner.delete(stale)
  }
  version += 1
  listeners.forEach((listener) => listener())
}

export function subscribeHostChatAnswers(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function hostChatAnswersVersion(): number {
  return version
}
