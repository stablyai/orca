import { describe, expect, it } from 'vitest'
import {
  getEphemeralVmRecipeCheckoutModeError,
  getEphemeralVmRecipeResultSchemaVersion
} from './ephemeral-vm-recipe-checkout-mode'
import type { OrcaVmRecipe } from './orca-yaml-hook-types'

const defaultRecipe: OrcaVmRecipe = {
  id: 'cloud-sandbox',
  name: 'Cloud Sandbox',
  create: './create.sh'
}

describe('ephemeral VM recipe checkout mode', () => {
  it('keeps existing recipes on schema version 1', () => {
    expect(getEphemeralVmRecipeResultSchemaVersion(defaultRecipe)).toBe(1)
    expect(
      getEphemeralVmRecipeCheckoutModeError(defaultRecipe, {
        schemaVersion: 1,
        pairingCode: 'orca://pair?code=test',
        projectRoot: '/workspace/repo'
      })
    ).toBeNull()
  })

  it('requires both sides to opt in to provisioned-root', () => {
    const provisionedRootResult = {
      schemaVersion: 2 as const,
      checkoutMode: 'provisioned-root' as const,
      pairingCode: 'orca://pair?code=test',
      projectRoot: '/workspace/repo'
    }
    expect(getEphemeralVmRecipeCheckoutModeError(defaultRecipe, provisionedRootResult)).toBe(
      'Recipe result requests provisioned-root checkout, but the recipe is not configured for it.'
    )
    expect(
      getEphemeralVmRecipeCheckoutModeError(
        { ...defaultRecipe, checkoutMode: 'provisioned-root' },
        provisionedRootResult
      )
    ).toBeNull()
  })
})
