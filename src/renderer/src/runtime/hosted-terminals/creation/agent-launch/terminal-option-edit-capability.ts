import type { TerminalOptionEdits } from '../../../../../../shared/agent-launch/choices/agent-launch-choices'
import { AGENT_LAUNCH_TERMINAL_OPTION_EDITS_CAPABILITY } from '../../../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'
import { runtimeEnvironmentCapabilityProof } from '../../../rpc/compatibility/runtime-capability-proof'
import { isRuntimeCompatBlockError } from '../../../rpc/compatibility/runtime-protocol-compat'

export type TerminalOptionEditDispatch = {
  terminalOptionEdits?: TerminalOptionEdits
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
}

/** A launch keeps its negotiated edit and destination proof across ambiguous retries. */
export function createTerminalOptionEditNegotiation(edits: TerminalOptionEdits | undefined) {
  let negotiated: Promise<TerminalOptionEditDispatch> | undefined
  return (environmentId: string): Promise<TerminalOptionEditDispatch> => {
    negotiated ??= (async () => {
      if (edits?.effort !== null) {
        return {}
      }
      try {
        const proof = await runtimeEnvironmentCapabilityProof(
          environmentId,
          AGENT_LAUNCH_TERMINAL_OPTION_EDITS_CAPABILITY
        )
        return proof.supported
          ? {
              terminalOptionEdits: { effort: null },
              expectedEnvironmentPairingRevision: proof.pairingRevision,
              expectedEnvironmentRuntimeId: proof.runtimeId
            }
          : {}
      } catch (error) {
        if (
          isRuntimeCompatBlockError(error) ||
          (error instanceof Error && error.name === 'AbortError')
        ) {
          throw error
        }
        return {}
      }
    })()
    return negotiated
  }
}
