import type { AppState } from '@/store/types'

type AgentStatusEpochState = Pick<AppState, 'agentStatusEpoch'>

/**
 * A store selector over live agent status that recomputes only when `agentStatusEpoch` or one of
 * `inputs` changes. Same-epoch writes change status metadata only, so subscribers skip
 * heartbeat-only updates while the result still reads the store's current state.
 */
export function createAgentStatusEpochSelector<
  State extends AgentStatusEpochState,
  Inputs extends readonly unknown[],
  Result
>(
  compute: (state: State, ...inputs: Inputs) => Result
): (state: State, ...inputs: Inputs) => Result {
  let cached: { epoch: number; inputs: Inputs; result: Result } | null = null
  return (state, ...inputs) => {
    if (
      cached &&
      cached.epoch === state.agentStatusEpoch &&
      cached.inputs.length === inputs.length &&
      cached.inputs.every((input, index) => Object.is(input, inputs[index]))
    ) {
      return cached.result
    }
    const result = compute(state, ...inputs)
    cached = { epoch: state.agentStatusEpoch, inputs, result }
    return result
  }
}
