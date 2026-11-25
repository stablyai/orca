import {
  createCommandDetailAuthority,
  type CommandDetailAuthority,
  type StructuredAgentSessionLiveReadCredit
} from '../../../../../../../shared/agent-session/view/live-read/command-detail-authority'

/** A read owner's exact-command credit. Contact loss and stop clear it outside the owner's
 *  `current` guard: contact can be lost while the owner is already stale. */
export function createReadOwnerCommandCredit(markStale: () => void): {
  reader: Pick<CommandDetailAuthority, 'open' | 'inspect'>
  /** Transport hooks for one run; each run's generations restart at one, so credit names the run. */
  forRun: () => { credit: StructuredAgentSessionLiveReadCredit; onContactLost: () => void }
  lost: () => void
} {
  const authority = createCommandDetailAuthority()
  const lost = (): void => {
    authority.invalidate(null)
    markStale()
  }
  return {
    reader: { open: authority.open, inspect: authority.inspect },
    lost,
    forRun: () => {
      const transport = {}
      const scope = (generation: number) => ({ transport, generation })
      return {
        onContactLost: lost,
        credit: {
          openGenerationAdvanced: (generation) => authority.invalidate(scope(generation)),
          subscribeCursor: (generation, cursor) => authority.seed(scope(generation), cursor),
          observeFrame: (event, generation, runtimeId) =>
            authority.observe(scope(generation), event, runtimeId)
        }
      }
    }
  }
}
