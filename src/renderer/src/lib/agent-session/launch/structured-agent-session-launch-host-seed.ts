import {
  notifyStructuredLaunchListeners,
  type StructuredLaunchState
} from './structured-agent-session-launch-state-store'

/** Each attempt's probe names the seed the paired server's create will use; the picker shows it. */
export function adoptPairedHostSeed(
  state: StructuredLaunchState,
  seedOptions: StructuredLaunchState['selection']['seed']
): void {
  // The support answer is a fresh seed; continuation baseline belongs to actual host create.
  if (state.intent.params.resumeFrom || state.intent.params.forkFrom) {
    seedOptions = undefined
  }
  const { seedPending, ...selection } = state.selection
  if (!seedPending && JSON.stringify(seedOptions) === JSON.stringify(state.intent.seedOptions)) {
    return
  }
  if (seedOptions) {
    state.intent.seedOptions = seedOptions
  } else {
    delete state.intent.seedOptions
  }
  state.selection = { ...selection, seed: seedOptions }
  notifyStructuredLaunchListeners(state.intent.sessionId)
}
