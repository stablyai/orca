// N-01: stable names for the phases of an Orca Cloud workspace create, logged to the main app log as
// `[orca-cloud] create <creationId> <phase> +<ms>` (ms since the create's provision started). Keep the
// names stable: log readers grep for them. The provision's own `[orca-cloud] <stage>` progress lines,
// which the create's progress text reads, are separate and unchanged.

/** Phases main sees: the provision call itself, the driver's progress lines, and its return. */
export const CLOUD_CREATE_MAIN_PHASES = [
  'provision-start',
  'provisioning',
  'plan-clone',
  'plan-update',
  'cloning',
  'updating',
  'connecting',
  'provision-end'
] as const

/** Phases the renderer reports after the provision returns, up to the workspace opening. */
export const CLOUD_CREATE_RENDERER_PHASES = [
  'runtime-catalog-start',
  'runtime-catalog-end',
  'env-check-start',
  'env-check-end',
  'workspace-create-start',
  'workspace-open',
  'failed'
] as const

export type CloudCreateMainPhase = (typeof CLOUD_CREATE_MAIN_PHASES)[number]
export type CloudCreateRendererPhase = (typeof CLOUD_CREATE_RENDERER_PHASES)[number]
export type CloudCreatePhase = CloudCreateMainPhase | CloudCreateRendererPhase

export function isCloudCreateRendererPhase(value: unknown): value is CloudCreateRendererPhase {
  return (CLOUD_CREATE_RENDERER_PHASES as readonly unknown[]).includes(value)
}

const PROVISION_LINE_PHASES = new Set<string>([
  'provisioning',
  'plan-clone',
  'plan-update',
  'cloning',
  'updating',
  'connecting'
])

/** The phase a driver progress line names (`[orca-cloud] <phase>…`), or null for any other line. */
export function cloudCreatePhaseFromProvisionLine(line: string): CloudCreateMainPhase | null {
  const match = /^\[orca-cloud\] ([a-z-]+)/.exec(line.trim())
  return match && PROVISION_LINE_PHASES.has(match[1]) ? (match[1] as CloudCreateMainPhase) : null
}
