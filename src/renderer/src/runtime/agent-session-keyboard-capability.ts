import { AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { isRuntimeCompatBlockError } from './runtime-protocol-compat'

type KeyboardOptions = { terminalKittyKeyboardProtocol?: true }

export function createAgentSessionKeyboardOptions(enabled: boolean | undefined) {
  let negotiated: Promise<KeyboardOptions> | undefined
  return (environmentId: string): Promise<KeyboardOptions> => {
    // A replay must keep its original payload even after a host upgrade or reconnect.
    negotiated ??= (async () => {
      if (enabled !== true) {
        return {}
      }
      try {
        const supported = await runtimeEnvironmentSupportsCapability(
          environmentId,
          AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY
        )
        return supported ? { terminalKittyKeyboardProtocol: true as const } : {}
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
