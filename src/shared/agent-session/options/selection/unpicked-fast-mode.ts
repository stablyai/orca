import { unpickedFastModeIsOff } from '../model-catalog/agent-model-catalog-ownership'

type FastState = {
  record: { agent: string; values: Record<string, { source: string } | undefined> }
  acceptedInputSources?: Readonly<Record<string, unknown>>
}

/** Before a host answers, only agents whose unpicked Fast is off send that off as policy. */
export function unpickedFastPolicy(agent: string): { fastMode?: 'policy' } {
  return unpickedFastModeIsOff(agent) ? { fastMode: 'policy' } : {}
}

/** An unpicked Fast the agent reported belongs to the old model; the new one runs its own default. */
export function dropStaleReportedFast(state: FastState, pickedId: string): void {
  if (
    pickedId === 'model' &&
    state.record.values.fastMode?.source === 'reported' &&
    !state.acceptedInputSources?.fastMode &&
    !unpickedFastModeIsOff(state.record.agent)
  ) {
    delete state.record.values.fastMode
  }
}
