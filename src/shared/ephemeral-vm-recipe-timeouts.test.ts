import { describe, expect, it } from 'vitest'
import {
  formatEphemeralVmRecipeTimeout,
  getEphemeralVmRecipeTimeoutSeconds,
  parseEphemeralVmRecipeTimeoutSeconds,
  toEphemeralVmRuntimeRecipeSnapshot
} from './ephemeral-vm-recipe-timeouts'
import { ephemeralVmTimeoutFailure } from './ephemeral-vm-failure-copy'
import type { OrcaVmRecipe } from './orca-yaml-hook-types'
import { parseOrcaYaml } from './orca-yaml'

describe('ephemeral VM recipe timeouts', () => {
  it('applies no limit unless the recipe sets one', () => {
    const recipe: OrcaVmRecipe = { id: 'r', name: 'R', create: './create.sh' }
    for (const mode of ['create', 'suspend', 'resume', 'destroy'] as const) {
      expect(getEphemeralVmRecipeTimeoutSeconds(recipe, mode)).toBeUndefined()
    }
    expect(
      getEphemeralVmRecipeTimeoutSeconds({ ...recipe, timeoutSeconds: { create: 90 } }, 'create')
    ).toBe(90)
    expect(
      getEphemeralVmRecipeTimeoutSeconds({ ...recipe, timeoutSeconds: { create: 90 } }, 'destroy')
    ).toBeUndefined()
  })

  it('rejects values that are not whole seconds in range', () => {
    for (const value of [0, -1, 1.5, 86_401, '60', [60], { create: '60' }, { create: 0 }]) {
      expect(parseEphemeralVmRecipeTimeoutSeconds(value).ok).toBe(false)
    }
    expect(parseEphemeralVmRecipeTimeoutSeconds({})).toEqual({ ok: true })
    expect(parseEphemeralVmRecipeTimeoutSeconds(86_400)).toMatchObject({ ok: true })
  })

  it('formats the limit compactly', () => {
    expect(formatEphemeralVmRecipeTimeout(45)).toBe('45s')
    expect(formatEphemeralVmRecipeTimeout(900)).toBe('15m')
    expect(formatEphemeralVmRecipeTimeout(5_400)).toBe('1h 30m')
  })

  it('tells the user which step stopped and how to raise the limit', () => {
    expect(ephemeralVmTimeoutFailure('create', 1_800)).toEqual({
      error:
        'The recipe create step did not finish within 30m, so Orca stopped it. Check the recipe output, or raise timeoutSeconds in orca.yaml if it needs longer.',
      errorCode: 'recipeTimedOut',
      errorParams: { mode: 'create', timeout: '30m', timeoutSeconds: 1_800 }
    })
  })

  it('drops timeoutSeconds from the persisted recipe snapshot', () => {
    const snapshot = toEphemeralVmRuntimeRecipeSnapshot({
      id: 'r',
      name: 'R',
      create: './create.sh',
      destroy: './destroy.sh',
      timeoutSeconds: { create: 60 }
    })
    expect(snapshot).toEqual({ id: 'r', name: 'R', create: './create.sh', destroy: './destroy.sh' })
  })
})

describe('orca.yaml recipe timeoutSeconds', () => {
  it('parses recipe timeoutSeconds as one limit or a per-step map', () => {
    const yaml = [
      'environmentRecipes:',
      '  - id: all-steps',
      '    name: All Steps',
      '    create: ./create.sh',
      '    timeoutSeconds: 120',
      '  - id: per-step',
      '    name: Per Step',
      '    create: ./create.sh',
      '    timeoutSeconds:',
      '      create: 1800',
      '      destroy: 60'
    ].join('\n')

    expect(parseOrcaYaml(yaml)?.environmentRecipes).toEqual([
      {
        id: 'all-steps',
        name: 'All Steps',
        create: './create.sh',
        timeoutSeconds: { create: 120, suspend: 120, resume: 120, destroy: 120 }
      },
      {
        id: 'per-step',
        name: 'Per Step',
        create: './create.sh',
        timeoutSeconds: { create: 1800, destroy: 60 }
      }
    ])
  })

  it('keeps a recipe with an invalid timeoutSeconds without limits and reports it', () => {
    const yaml = [
      'environmentRecipes:',
      '  - id: cloud-sandbox',
      '    name: Cloud Sandbox',
      '    create: ./create.sh',
      '    timeoutSeconds:',
      '      boot: 60'
    ].join('\n')

    expect(parseOrcaYaml(yaml)).toEqual({
      scripts: {},
      environmentRecipes: [{ id: 'cloud-sandbox', name: 'Cloud Sandbox', create: './create.sh' }],
      environmentRecipeDiagnostics: [
        {
          index: 0,
          field: 'timeoutSeconds',
          message:
            'Recipe "cloud-sandbox" timeoutSeconds.boot is not a lifecycle step; use create, suspend, resume, or destroy. Steps keep no time limit.'
        }
      ]
    })
  })
})
