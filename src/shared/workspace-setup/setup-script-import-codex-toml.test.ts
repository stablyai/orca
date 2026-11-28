import { expect, it } from 'vitest'
import { inspectSetupScriptImportCandidates } from './setup-script-imports'

const inspect = (content: string) =>
  inspectSetupScriptImportCandidates(async (path) =>
    path === '.codex/environments/environment.toml' ? content : null
  )

it('decodes multiline TOML scripts before offering them for workspace setup', async () => {
  const candidates = await inspect(String.raw`[setup]
script = """
printf '%s\\n' \"hello world\"
"""
[cleanup]
script = '''printf '%s\n' "cleanup"'''
`)

  expect(candidates).toEqual([
    {
      provider: 'codex',
      label: 'Codex environment',
      files: ['.codex/environments/environment.toml'],
      setup: String.raw`printf '%s\n' "hello world"`,
      archive: String.raw`printf '%s\n' "cleanup"`,
      unsupportedFields: []
    }
  ])
})

it('does not import a setup section quoted inside another TOML value', async () => {
  expect(
    await inspect(`example = '''
[setup]
script = "echo example"
'''
`)
  ).toEqual([])
})
