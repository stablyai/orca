export type AgentChildWorkInvocationFence = {
  invocationId: string
  generation: number
}

export function agentChildWorkFencesEqual(
  left: AgentChildWorkInvocationFence,
  right: AgentChildWorkInvocationFence
): boolean {
  return left.invocationId === right.invocationId && left.generation === right.generation
}
