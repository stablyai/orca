import {
  AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY,
  AGENT_SESSION_THEME_PARAMS_RUNTIME_CAPABILITY
} from '../../../../../../shared/agent-session/capabilities/agent-session-runtime-capabilities'
import type { TerminalOscColorQueryReplyColors } from '../../../../../../shared/terminal/protocol/queries/terminal-osc-color-reply'
import { terminalCreateThemeParams } from '../../../../components/terminal-pane/appearance/terminal-view-attributes-publisher'
import { runtimeEnvironmentSupportsCapability } from '../../../rpc/compatibility/runtime-capability-proof'
import { peekRuntimeEnvironmentCapability } from '../../../rpc/compatibility/runtime-compatibility-cache'
import { isRuntimeCompatBlockError } from '../../../rpc/compatibility/runtime-protocol-compat'

type TerminalOptions = { terminalKittyKeyboardProtocol?: true } & ReturnType<
  typeof terminalCreateThemeParams
>

/** Older launch schemas reject unknown fields; send each option only where the host advertises it. */
export function createAgentSessionTerminalOptions(
  kittyKeyboard: boolean | undefined,
  colors: TerminalOscColorQueryReplyColors | undefined
) {
  // Snapshot the palette with the colors: the host drops attributes that disagree with them.
  const theme = terminalCreateThemeParams(colors)
  let negotiated: Promise<TerminalOptions> | undefined
  return (environmentId: string): Promise<TerminalOptions> => {
    // A replay must keep its original payload even after a host upgrade or reconnect.
    negotiated ??= (async () => {
      // Separate probes keep one option if the other fails; serial so the theme peek reuses that status.
      const keyboardSupported = await hostSupports(kittyKeyboard === true, () =>
        runtimeEnvironmentSupportsCapability(
          environmentId,
          AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY
        )
      )
      const themeSupported = await hostSupports(
        colors !== undefined,
        async () =>
          peekRuntimeEnvironmentCapability(
            environmentId,
            AGENT_SESSION_THEME_PARAMS_RUNTIME_CAPABILITY
          ) ??
          (await runtimeEnvironmentSupportsCapability(
            environmentId,
            AGENT_SESSION_THEME_PARAMS_RUNTIME_CAPABILITY
          ))
      )
      return {
        ...(keyboardSupported ? { terminalKittyKeyboardProtocol: true as const } : {}),
        ...(themeSupported ? theme : {})
      }
    })()
    return negotiated
  }
}

// Why gated: a negative keyboard answer clears the status cache, so probe only options being sent.
async function hostSupports(wanted: boolean, probe: () => Promise<boolean>): Promise<boolean> {
  if (!wanted) {
    return false
  }
  try {
    return await probe()
  } catch (error) {
    if (isRuntimeCompatBlockError(error)) {
      throw error
    }
    return false
  }
}
