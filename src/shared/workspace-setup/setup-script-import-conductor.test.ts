import { expect, it } from 'vitest'
import { inspectSetupScriptImportCandidates } from './setup-script-imports'

it('lets empty local Conductor script values override shared commands', async () => {
  const files = new Map([
    ['.conductor/settings.toml', '[scripts]\nsetup = "./setup.sh"\narchive = "./archive.sh"\n'],
    ['.conductor/settings.local.toml', '[scripts]\nsetup = ""\n']
  ])
  const read = () => inspectSetupScriptImportCandidates(async (path) => files.get(path) ?? null)
  expect(await read()).toEqual([])

  files.set('.conductor/settings.local.toml', '[scripts]\narchive = ""\n')
  expect(await read()).toEqual([
    {
      provider: 'conductor',
      label: 'Conductor',
      files: ['.conductor/settings.toml', '.conductor/settings.local.toml'],
      setup: './setup.sh',
      archive: undefined,
      unsupportedFields: []
    }
  ])

  files.set('.conductor/settings.local.toml', '[scripts]\nsetup = "./local-setup.sh"\n')
  expect(await read()).toEqual([
    {
      provider: 'conductor',
      label: 'Conductor',
      files: ['.conductor/settings.toml', '.conductor/settings.local.toml'],
      setup: './local-setup.sh',
      archive: './archive.sh',
      unsupportedFields: []
    }
  ])
})
