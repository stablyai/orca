import { hostPlatformDisplayName } from './host-platform-label'

export type HostDisplayResolutionInput = {
  /** The label the caller already owns: a stored resolved name, or a desktop-local server label. */
  name: string
  machineName?: string | null
  platform?: NodeJS.Platform | null
}

export type HostDisplayResolution = {
  title: string
  /** OS plus a distinct machine name, OS alone when names match, or null when neither is known. */
  descriptorLine: string | null
}

/** Titles always use the caller’s label; machine names belong only in descriptors so late metadata cannot retitle rows. */
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
