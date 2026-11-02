import { beforeEach, expect, it, vi } from 'vitest'
import type { PluginSyntaxMetadata } from '../../../shared/plugins/artifacts/plugin-syntax-artifact'
import {
  pluginSyntaxRevisionKey,
  recordPluginSyntaxFailure,
  usePluginSyntaxFailureStore
} from './plugin-syntax-failures'
import { usePluginSyntaxStore } from './plugin-syntax-packs'

function syntax(revision: string): PluginSyntaxMetadata {
  return {
    id: 'plugin:samples.demo/yaml',
    pluginKey: 'samples.demo',
    label: 'yaml',
    extensions: ['.yaml'],
    filenames: [],
    revision
  }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  usePluginSyntaxFailureStore.setState({ failures: {} })
  usePluginSyntaxStore.setState({ entries: [], loaded: false })
})

it('shows no failure once revision B replaces a failed revision A', () => {
  const a = syntax('a')
  const b = syntax('b')
  usePluginSyntaxStore.setState({ entries: [a], loaded: true })
  recordPluginSyntaxFailure(pluginSyntaxRevisionKey(a), 'crashed')
  const { failures } = usePluginSyntaxFailureStore.getState()
  expect(failures[pluginSyntaxRevisionKey(a)]).toBe('crashed')

  usePluginSyntaxStore.setState({ entries: [b], loaded: true })

  expect(usePluginSyntaxFailureStore.getState().failures).toEqual({})
})

it('keeps the failure of a revision that is still installed', () => {
  const a = syntax('a')
  usePluginSyntaxStore.setState({ entries: [a], loaded: true })
  recordPluginSyntaxFailure(pluginSyntaxRevisionKey(a), 'stalled')

  usePluginSyntaxStore.setState({ entries: [{ ...a, label: 'YAML' }], loaded: true })

  expect(usePluginSyntaxFailureStore.getState().failures).toEqual({
    'plugin:samples.demo/yaml@a': 'stalled'
  })
})
