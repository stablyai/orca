import { hostPlatformDisplayName } from './host-platform-label'

export type HostDisplayResolutionInput = {
  /** The label the caller already owns: a stored resolved name, or a desktop-local server label. */
  name: string
  machineName?: string | null
  platform?: NodeJS.Platform | null
}

export type HostDisplayResolution = {
  title: string
  /**
   * "OS · machine name" when the machine name differs from the shown title, the OS alone when it
   * matches (the OS is always shown when known), or null when the host reported neither.
   */
  descriptorLine: string | null
}

/**
 * The one display rule for host rows and headers. The title is always the caller's own label —
 * a machine name can appear only on the descriptor line, never as the title, so a late-arriving
 * descriptor can never retitle a row.
 */
export function resolveHostDisplay(input: HostDisplayResolutionInput): HostDisplayResolution {
  const title = normalize(input.name) ?? 'Host'
  const machineName = normalize(input.machineName)
  const descriptorLine =
    [hostPlatformDisplayName(input.platform ?? null), machineName === title ? null : machineName]
      .filter(Boolean)
      .join(' · ') || null
  return { title, descriptorLine }
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}
