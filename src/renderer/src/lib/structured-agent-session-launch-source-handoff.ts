import { structuredAgentSessionCreateFingerprint } from '../../../shared/structured-agent-session-mutation'
import {
  setStructuredLaunchState,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

/** A joiner without the terminal pane must not fail when that pane closes: the unsent create hands
 *  off now and resumes by conversation id, as a History click does. */
export function releaseStructuredLaunchSource(state: StructuredLaunchState): void {
  const { intent } = state
  const handoff = intent.beforeCreate
  if (!handoff) {
    return
  }
  delete intent.beforeCreate
  handoff()
  const resumeFrom = intent.params.resumeFrom
  if (!resumeFrom?.cliSource) {
    return
  }
  const { cliSource: _paneSource, ...resumeById } = resumeFrom
  const params = { ...intent.params, resumeFrom: resumeById }
  intent.params = {
    ...params,
    envelope: {
      ...params.envelope,
      payloadFingerprint: structuredAgentSessionCreateFingerprint({
        sessionId: intent.sessionId,
        ...params
      })
    }
  }
  setStructuredLaunchState(state)
}
