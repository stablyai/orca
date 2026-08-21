import { stripCredentialsFromMessage } from './git-remote-error'
import type { MCodeVmRecipe } from './mcode-yaml-hook-types'

export function getProvisionedRootRecipeRepoUrl(
  checkoutMode: MCodeVmRecipe['checkoutMode'],
  remoteUrl: string | undefined
): string | undefined {
  if (checkoutMode !== 'provisioned-root' || !remoteUrl) {
    return undefined
  }
  return stripCredentialsFromMessage(remoteUrl)
}
