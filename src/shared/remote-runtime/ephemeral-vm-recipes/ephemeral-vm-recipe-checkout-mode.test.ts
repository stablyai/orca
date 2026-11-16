import { describe, expect, it } from 'vitest'
import { getEphemeralVmRecipeCheckoutModeFailure } from './ephemeral-vm-recipe-checkout-mode'
import type { OrcaVmRecipe } from '../../workspace-setup/orca-yaml-hook-types'

const defaultRecipe: OrcaVmRecipe = {
  id: 'cloud-sandbox',
  name: 'Cloud Sandbox',
  create: './create.sh'
}

describe('ephemeral VM recipe checkout mode', () => {
  it('requires both sides to opt in to provisioned-root', () => {
    const provisionedRootResult = {
      schemaVersion: 2 as const,
      checkoutMode: 'provisioned-root' as const,
      pairingCode: 'orca://pair?code=test',
      projectRoot: '/workspace/repo'
    }
    expect(getEphemeralVmRecipeCheckoutModeFailure(defaultRecipe, provisionedRootResult)).toEqual({
      error:
        'Recipe result requests provisioned-root checkout, but the recipe is not configured for it.',
      errorCode: 'provisionedRootNotConfigured'
    })
    expect(
      getEphemeralVmRecipeCheckoutModeFailure(
        { ...defaultRecipe, checkoutMode: 'provisioned-root' },
        provisionedRootResult
      )
    ).toBeNull()
  })
})
