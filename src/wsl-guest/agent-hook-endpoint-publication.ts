import { writeEndpointFile } from '../shared/agent-hook-listener/endpoint-publication'
import {
  ORCA_HOOK_PROTOCOL_VERSION,
  ORCA_HOOK_RAW_JSON_TRANSPORT
} from '../shared/agent-hook-types'

export function publishRelayHookEndpoint(
  endpointDir: string,
  endpointFilePath: string,
  port: number,
  token: string,
  env: string
): boolean {
  if (port <= 0 || !token) {
    return false
  }
  return writeEndpointFile(endpointDir, endpointFilePath, {
    port,
    token,
    env,
    version: ORCA_HOOK_PROTOCOL_VERSION,
    openCodeTui: true,
    transport: ORCA_HOOK_RAW_JSON_TRANSPORT
  })
}
