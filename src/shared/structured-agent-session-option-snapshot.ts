import type { StructuredAgentSessionOptionState } from './structured-agent-session-options'
import type { SessionOptionDescriptor } from './native-chat-session-options'
import {
  buildNativeChatSessionOptionSnapshot,
  withTrackedNativeChatModel
} from './native-chat-session-option-snapshot'
import { structuredAgentSessionPermissionDescriptor } from './structured-agent-session-permission-option'

/** Before the host answers, or an agent with no list reports, the quiet model pill: never
 *  pickable, so displaying it can never become a launch pick. */
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

export function structuredAgentSessionOptionSnapshot(
  state: StructuredAgentSessionOptionState
): SessionOptionDescriptor[] {
  const permission = structuredAgentSessionPermissionDescriptor(state)
  const options = modelOptionSnapshot(state)
  return permission ? [...options, permission] : options
}

function modelOptionSnapshot(state: StructuredAgentSessionOptionState): SessionOptionDescriptor[] {
  if (!state.catalog) {
    return []
  }
  // Until the host answers, the built-in list would paint a label its list may replace.
  if (state.catalogSource === 'seed') {
    return [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
  }
  const snapshot = buildNativeChatSessionOptionSnapshot({
    catalog: state.catalog,
    // A seeded default can name a model the static seed does not list yet.
    models: withTrackedNativeChatModel(state.catalog, state.catalog.models, state.record),
    record: state.record,
    mode: 'live',
    modelLabel: 'Model',
    liveTransport: 'agent-session'
  })
  return snapshot.length > 0 || state.catalogSource === 'live'
    ? snapshot
    : [PROVIDER_DEFAULT_MODEL_PLACEHOLDER]
}

/** No launch holds a pick and no fence can carry one yet, so the picker only shows. */
export function lockedStructuredAgentSessionOptionSnapshot(
  snapshot: readonly SessionOptionDescriptor[]
): SessionOptionDescriptor[] {
  return snapshot.map((descriptor) => ({
    ...descriptor,
    settable: false,
    disabledReason: 'available-after-session-start'
  }))
}
