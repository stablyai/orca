import { AGENT_SUBAGENT_ID_MAX_LENGTH } from '../agent-status/contracts/agent-status-subagent-snapshot'

/** A child id within the snapshot cap; long ids keep their leaf and a hash of the whole path. */
export function boundedProgramStatusChildId(id: string): string {
  if (id.length <= AGENT_SUBAGENT_ID_MAX_LENGTH) {
    return id
  }
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193) >>> 0
  }
  const prefix = `${hash.toString(16).padStart(8, '0')}~`
  return prefix + id.slice(-(AGENT_SUBAGENT_ID_MAX_LENGTH - prefix.length))
}
