import { describe, expect, it } from 'vitest'
import {
  listPluginVmRecipeCommands,
  parsePluginVmRecipeArtifact as parseArtifact
} from './plugin-vm-recipe-artifact'
import type { OrcaVmRecipe } from '../orca-yaml-hook-types'

function parsePluginVmRecipeArtifact(raw: string): OrcaVmRecipe {
  const artifact = parseArtifact(raw)
  if (artifact.kind !== 'recipe') {
    throw new Error('expected a lifecycle recipe')
  }
  return artifact.recipe
}

function machineProviderArtifact(command: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    id: 'omarchy',
    name: 'Omarchy box',
    machines: { command },
    ...extra
  })
}

describe('plugin VM recipe artifacts', () => {
  it('parses bounded lifecycle commands for verbatim consent', () => {
    const recipe = parsePluginVmRecipeArtifact(
      JSON.stringify({
        schemaVersion: 1,
        id: 'cloud-sandbox',
        name: 'Cloud Sandbox',
        checkoutMode: 'provisioned-root',
        create: './scripts/create.sh',
        suspend: './scripts/suspend.sh',
        resume: './scripts/resume.sh',
        destroy: './scripts/destroy.sh'
      })
    )

    expect(recipe).toMatchObject({
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      checkoutMode: 'provisioned-root'
    })
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

  it('parses a schemaVersion 2 machine provider as a distinct kind', () => {
    expect(
      parseArtifact(
        machineProviderArtifact(['ssh', '-o', 'BatchMode=yes', 'omarchy', 'orca-sandbox'])
      )
    ).toEqual({
      kind: 'machine-provider',
      provider: {
        id: 'omarchy',
        name: 'Omarchy box',
        command: ['ssh', '-o', 'BatchMode=yes', 'omarchy', 'orca-sandbox']
      }
    })
    expect(
      parseArtifact(machineProviderArtifact(['$orca-node', '$plugin/bin/provider.mjs'])).kind
    ).toBe('machine-provider')
    expect(parseArtifact(machineProviderArtifact(['/usr/local/bin/provider'])).kind).toBe(
      'machine-provider'
    )
    expect(parseArtifact(machineProviderArtifact(['C:\\tools\\provider.exe'])).kind).toBe(
      'machine-provider'
    )
  })

  it('rejects machine provider argv that could resolve against the spawn cwd or escape the plugin', () => {
    for (const command of [
      [],
      ['./provider'],
      ['bin/provider'],
      ['..\\provider.exe'],
      ['$plugin/../outside'],
      ['$plugin//etc/passwd'],
      ['ssh', '$plugin/../outside'],
      ['ssh', '$orca-node'],
      ['bad\0arg']
    ]) {
      expect(
        () => parseArtifact(machineProviderArtifact(command)),
        JSON.stringify(command)
      ).toThrow()
    }
  })

  it('keeps machine providers nested-only and strict', () => {
    // A v2 artifact never falls back to a top-level shell command.
    expect(() =>
      parseArtifact(JSON.stringify({ schemaVersion: 2, id: 'x', name: 'X', command: ['ssh'] }))
    ).toThrow()
    expect(() =>
      parseArtifact(machineProviderArtifact(['ssh'], { create: './create.sh' }))
    ).toThrow()
    expect(() =>
      parseArtifact(
        JSON.stringify({ schemaVersion: 1, id: 'x', name: 'X', machines: { command: ['ssh'] } })
      )
    ).toThrow()
  })
})
