import { translate } from '@/i18n/i18n'
import { formatWorkspaceNumber } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { findCollidingEnvironmentName } from '../../../../shared/remote-runtime/host-catalog/runtime-environment-name-collision'

/**
 * The server name this computer saves for a cloud workspace. Server names are unique, and two
 * workspaces from the same repository share a title, so the second one couldn't be paired ("Couldn't
 * open the workspace on the sandbox"). A taken name gets the workspace's W-number, then a counter.
 */
export function pickCloudServerName(
  base: string,
  number: number | null,
  existing: readonly { name: string }[]
): string {
  const label = (value: string): string =>
    translate('auto.components.cloudWorkspaces.environmentName', '{{value0}} (cloud)', {
      value0: value
    }).slice(0, 120)
  const free = (candidate: string): boolean => !findCollidingEnvironmentName(existing, candidate)
  const first = label(base)
  if (free(first)) {
    return first
  }
  const numbered = number ? `${base} ${formatWorkspaceNumber(number)}` : base
  for (let n = 1; n < 100; n++) {
    const candidate = label(n === 1 && number ? numbered : `${numbered} ${n}`)
    if (free(candidate)) {
      return candidate
    }
  }
  return label(`${numbered} ${Date.now()}`)
}

export async function uniqueCloudServerName(base: string, number: number | null): Promise<string> {
  const environments = await window.api.runtimeEnvironments.list().catch(() => [])
  return pickCloudServerName(base, number, environments)
}
