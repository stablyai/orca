// One capability policy for the initial provider adapters and their local launch surfaces.
import type { ProfileAgent, ProfileBinding } from './agent-launch-profile'
const capabilities = {
  create: true,
  connectHome: true,
  inspectExternalIdentity: false,
  terminal: true,
  managedStructured: true
} as const
export const AGENT_PROFILE_CAPABILITIES: Record<ProfileAgent, typeof capabilities> = {
  claude: capabilities,
  codex: capabilities
}
export function isProfileAgent(agent: string): agent is ProfileAgent {
  return Object.hasOwn(AGENT_PROFILE_CAPABILITIES, agent)
}
export function profileRequiresFreshTerminal(binding: ProfileBinding): boolean {
  return binding.kind === 'external'
}

export function supportsAgentProfileHost(host: {
  platform: string
  hostId: string
  isWsl: boolean
}): boolean {
  return host.hostId === 'local' && !host.isWsl && ['darwin', 'linux'].includes(host.platform)
}
