import { stripCredentialsFromMessage } from './git-remote-error'
import type { OrcaVmRecipe } from './orca-yaml-hook-types'

export function getProvisionedRootRecipeRepoUrl(
  checkoutMode: OrcaVmRecipe['checkoutMode'],
  remoteUrl: string | undefined
): string | undefined {
  if (checkoutMode !== 'provisioned-root' || !remoteUrl) {
    return undefined
  }
  return stripCredentialsFromMessage(remoteUrl)
}
