import { AGENT_SESSION_COLOR_QUERY_REPLIES_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { TerminalOscColorQueryReplyColors } from '../../../shared/terminal-osc-color-reply'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

type ColorOptions = { terminalColorQueryReplies?: TerminalOscColorQueryReplyColors }

/** Freeze the negotiated payload across retries of one host-owned agent launch. */
export function createAgentSessionColorOptions(
  colors: TerminalOscColorQueryReplyColors | undefined
) {
  let negotiated: Promise<ColorOptions> | undefined
  return (environmentId: string): Promise<ColorOptions> => {
    negotiated ??= (async () => {
      if (!colors?.foreground || !colors.background) {
        return {}
      }
      try {
        const supported = await runtimeEnvironmentSupportsCapability(
          environmentId,
          AGENT_SESSION_COLOR_QUERY_REPLIES_RUNTIME_CAPABILITY
        )
        return supported ? { terminalColorQueryReplies: colors } : {}
      } catch (error) {
        if (isRuntimeCompatBlockError(error)) {
          throw error
        }
        return {}
      }
    })()
    return negotiated
  }
}
