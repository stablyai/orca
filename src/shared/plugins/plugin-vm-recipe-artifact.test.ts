import { describe, expect, it } from 'vitest'
import {
  listPluginVmRecipeCommands,
  parsePluginVmRecipeArtifact
} from './plugin-vm-recipe-artifact'

describe('plugin VM recipe artifacts', () => {
  it('parses bounded lifecycle commands for verbatim consent', () => {
    const recipe = parsePluginVmRecipeArtifact(
      JSON.stringify({
        schemaVersion: 1,
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        create: './scripts/create.sh',
        suspend: './scripts/suspend.sh',
        resume: './scripts/resume.sh',
        destroy: './scripts/destroy.sh'
      })
    )

    expect(recipe).toMatchObject({ id: 'cloud-sandbox', name: 'Cloud Sandbox' })
    expect(listPluginVmRecipeCommands(recipe)).toEqual([
      { phase: 'create', command: './scripts/create.sh' },
      { phase: 'suspend', command: './scripts/suspend.sh' },
      { phase: 'resume', command: './scripts/resume.sh' },
      { phase: 'destroy', command: './scripts/destroy.sh' }
    ])
  })

  it('requires paired suspend/resume commands and rejects unknown fields', () => {
    expect(() =>
      parsePluginVmRecipeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          id: 'broken',
          name: 'Broken',
          create: 'create',
          suspend: 'suspend'
        })
      )
    ).toThrow('suspend and resume')
    expect(() =>
      parsePluginVmRecipeArtifact(
        JSON.stringify({
          schemaVersion: 1,
          id: 'broken',
          name: 'Broken',
          create: 'create',
          environment: { SECRET: 'value' }
        })
      )
    ).toThrow()
  })

  it('represents an explicitly disabled destroy action without executing text', () => {
    const recipe = parsePluginVmRecipeArtifact(
      JSON.stringify({
        schemaVersion: 1,
        id: 'managed',
        name: 'Managed',
        create: 'create',
        destroy: 'none'
      })
    )

    expect(recipe).toMatchObject({ destroyDisabled: true })
    expect(recipe.destroy).toBeUndefined()
  })

  it('rejects NUL bytes and commands beyond the bounded artifact contract', () => {
    for (const create of ['bad\0command', 'x'.repeat(32 * 1024 + 1)]) {
      expect(() =>
        parsePluginVmRecipeArtifact(
          JSON.stringify({ schemaVersion: 1, id: 'bounded', name: 'Bounded', create })
        )
      ).toThrow()
    }
  })
})
