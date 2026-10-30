import { expect, it } from 'vitest'
import type { PluginSyntaxMetadata } from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import { matchPluginSyntax } from './plugin-syntax-packs'

function syntax(id: string, extensions: string[], filenames: string[] = []): PluginSyntaxMetadata {
  return {
    id: `plugin:samples.demo/${id}`,
    pluginKey: 'samples.demo',
    label: id,
    extensions,
    filenames,
    revision: 'r'
  }
}

it('prefers an exact file name, then the longest extension, case-insensitively', () => {
  const entries = [
    syntax('yaml', ['.yaml']),
    syntax('compose', ['.compose.yaml']),
    syntax('build', [], ['buildfile'])
  ]
  expect(matchPluginSyntax(entries, 'deploy/App.Compose.YAML')?.label).toBe('compose')
  expect(matchPluginSyntax(entries, 'C:\\repo\\a.yaml')?.label).toBe('yaml')
  expect(matchPluginSyntax(entries, 'repo/Buildfile')?.label).toBe('build')
  expect(matchPluginSyntax(entries, 'repo/.yaml')).toBeNull()
  expect(matchPluginSyntax(entries, 'repo/readme.md')).toBeNull()
})
