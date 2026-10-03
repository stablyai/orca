import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { AgentInterruptInferenceRequest } from '../../../../shared/agent-interrupt-intent'
import { createAgentInterruptInference } from '../terminal-pane/agent-interrupt-inference'

type Dependencies = {
  paneKey: string
  getStatusEntry: () => AgentStatusEntry | undefined
  writeAccepted: () => Promise<boolean>
  inferInterrupt: (request: AgentInterruptInferenceRequest) => Promise<boolean>
}

/** Chat writes bypass xterm's acknowledged-input observer; reuse its guarded inference. */
export function createNativeChatAntigravityInterrupt(deps: Dependencies): {
  cancel(): Promise<void>
  dispose(): void
} {
  let disposed = false
  let sequence = 0
  let pending: ReturnType<typeof createAgentInterruptInference> | null = null
  return {
    async cancel() {
      const baseline = deps.getStatusEntry()
      const captured = baseline?.observation ? { ...baseline.observation } : undefined
      const capturedSequence = ++sequence
      pending?.dispose()
      pending = null
      if (!(await deps.writeAccepted()) || disposed || capturedSequence !== sequence) {
        return
      }
      if (baseline?.agentType !== 'antigravity' || !captured) {
        return
      }
      const inference = createAgentInterruptInference({
        paneKey: deps.paneKey,
        getStatusEntry: deps.getStatusEntry,
        inferInterrupt: (request) => {
          const current = deps.getStatusEntry()
          const observed = current?.observation
          if (
            disposed ||
            capturedSequence !== sequence ||
            !captured ||
            !observed ||
            captured.authorityId !== observed.authorityId ||
            captured.incarnation !== observed.incarnation ||
            captured.revision !== observed.revision
          ) {
            return false
          }
          return deps.inferInterrupt(request)
        }
      })
      pending = inference
      inference.observeInputIntent('plain-escape', baseline)
    },
    dispose() {
      disposed = true
      sequence += 1
      pending?.dispose()
      pending = null
    }
  }
}
