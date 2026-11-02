import { NODE_RUNTIME_PIN } from './node-runtime-pin'
import type { OrcadPreflightRuntimeIdentity } from './orcad-profile-preflight'

/** What a Node slot's candidate must report: the pinned runtime, never a host Node. */
export const ORCAD_NODE_RUNTIME_IDENTITY: OrcadPreflightRuntimeIdentity = {
  runtime: 'node',
  runtimeVersion: NODE_RUNTIME_PIN.version
}
