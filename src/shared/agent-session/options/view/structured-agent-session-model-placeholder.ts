import type { SessionOptionDescriptor } from '../../../native-chat/input/native-chat-session-options'
import type { StructuredAgentSessionOptionState } from '../structured-agent-session-options'

/** Unpickable placeholder cannot become a launch selection before a real model answer. */
const PROVIDER_DEFAULT_MODEL_PLACEHOLDER: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: { type: 'select', choices: [] },
  valueSource: 'unknown',
  transport: 'agent-session',
  settable: false,
  disabledReason: 'available-after-session-start'
}

/** Why the placeholder can't be picked yet: agy isn't signed in, its list is on the way, or the
 *  session names its models once it starts. */
export function modelPlaceholder(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor {
  return state.catalogSignedOut
    ? { ...PROVIDER_DEFAULT_MODEL_PLACEHOLDER, disabledReason: 'sign-in-for-models' }
    : state.listingInProgress
      ? { ...PROVIDER_DEFAULT_MODEL_PLACEHOLDER, disabledReason: 'models-loading' }
      : PROVIDER_DEFAULT_MODEL_PLACEHOLDER
}
