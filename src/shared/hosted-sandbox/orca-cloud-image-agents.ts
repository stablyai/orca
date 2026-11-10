import type { TuiAgent } from '../agent-launch/catalog/tui-agent'

/**
 * Agent CLIs every Orca Cloud golden image installs (cloud/apps/sandbox-control/image), in picker
 * order. Pickers that choose an agent before a VM exists (desktop composer, phone, API) offer only
 * these; inside a running workspace the VM's own detection is the source. The image test fails when
 * the manifest stops shipping one of them.
 */
export const ORCA_CLOUD_IMAGE_AGENTS = [
  'claude',
  'codex',
  'opencode',
  'gemini',
  'cursor',
  'copilot'
] as const satisfies readonly TuiAgent[]

export type OrcaCloudImageAgent = (typeof ORCA_CLOUD_IMAGE_AGENTS)[number]

export const ORCA_CLOUD_DEFAULT_AGENT: OrcaCloudImageAgent = 'claude'

export function isOrcaCloudImageAgent(agent: string): agent is OrcaCloudImageAgent {
  return (ORCA_CLOUD_IMAGE_AGENTS as readonly string[]).includes(agent)
}
