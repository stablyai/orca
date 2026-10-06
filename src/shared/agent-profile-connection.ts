// Public profile management DTOs; binding authority belongs to the execution host.
import { isProfileAgent } from './agent-profile-capabilities'
import type {
  AgentLaunchProfile,
  ProfileAgent,
  ProfileBinding,
  ProfileIdentity
} from './agent-launch-profile'
export type AgentProfileConnectionInput = {
  agent: ProfileAgent
  source: { kind: 'home' | 'command'; value: string } | { kind: 'managed'; accountId: string }
}
export type AgentProfileCandidate = {
  agent: ProfileAgent
  hostId: AgentLaunchProfile['hostId']
  executable: string
  binding: ProfileBinding
  resolvedHome: string
  identity: ProfileIdentity
}
export type AgentProfileSaveInput = {
  id?: string
  name: string
  connection: AgentProfileConnectionInput
}
export type AgentProfilesApi = {
  preview(input: AgentProfileConnectionInput): Promise<AgentProfileCandidate>
  save(input: AgentProfileSaveInput): Promise<AgentLaunchProfile>
  unlink(id: string): Promise<void>
}
export function isAgentProfileConnectionInput(
  value: unknown
): value is AgentProfileConnectionInput {
  if (
    !value ||
    typeof value !== 'object' ||
    !('agent' in value) ||
    typeof value.agent !== 'string' ||
    !isProfileAgent(value.agent) ||
    !('source' in value)
  ) {
    return false
  }
  const source = value.source
  if (!source || typeof source !== 'object' || !('kind' in source)) {
    return false
  }
  return source.kind === 'managed'
    ? 'accountId' in source &&
        typeof source.accountId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(source.accountId)
    : (source.kind === 'home' || source.kind === 'command') &&
        'value' in source &&
        typeof source.value === 'string' &&
        source.value.length > 0 &&
        source.value.length <= 4096 &&
        ![...source.value].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
        )
}

export function isAgentProfileSaveInput(input: unknown): input is AgentProfileSaveInput {
  return Boolean(
    input &&
    typeof input === 'object' &&
    'name' in input &&
    typeof input.name === 'string' &&
    'connection' in input &&
    isAgentProfileConnectionInput(input.connection) &&
    (!('id' in input) ||
      input.id === undefined ||
      (typeof input.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input.id)))
  )
}
