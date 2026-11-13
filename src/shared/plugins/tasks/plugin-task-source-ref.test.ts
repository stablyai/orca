import { describe, expect, it } from 'vitest'
import {
  parsePluginTaskSourceKey,
  pluginTaskSourceKey,
  resolveActivePluginTaskSource
} from './plugin-task-source-ref'

const ROADMAP = { pluginKey: 'orca-samples.roadmap', sourceId: 'roadmap' }

describe('plugin task source keys', () => {
  it('round-trips a source through its settings key', () => {
    expect(parsePluginTaskSourceKey(pluginTaskSourceKey(ROADMAP))).toEqual(ROADMAP)
  })

  it('rejects malformed keys', () => {
    expect(parsePluginTaskSourceKey(null)).toBeNull()
    expect(parsePluginTaskSourceKey('roadmap')).toBeNull()
    expect(parsePluginTaskSourceKey('/roadmap')).toBeNull()
    expect(parsePluginTaskSourceKey('orca-samples.roadmap/Road Map')).toBeNull()
    expect(parsePluginTaskSourceKey('nodot/roadmap')).toBeNull()
  })
})

describe('resolveActivePluginTaskSource', () => {
  const base = {
    requested: undefined,
    requestsBuiltin: false,
    savedDefault: null,
    available: [ROADMAP],
    availableReady: true
  }

  it('opens a requested or remembered source the plugin still offers', () => {
    expect(resolveActivePluginTaskSource({ ...base, requested: ROADMAP })).toEqual({
      kind: 'plugin',
      source: ROADMAP
    })
    expect(
      resolveActivePluginTaskSource({ ...base, savedDefault: 'orca-samples.roadmap/roadmap' })
    ).toEqual({ kind: 'plugin', source: ROADMAP })
  })

  it('ignores the remembered source when the opener asked for a built-in one', () => {
    expect(
      resolveActivePluginTaskSource({
        ...base,
        requestsBuiltin: true,
        savedDefault: 'orca-samples.roadmap/roadmap'
      })
    ).toEqual({ kind: 'builtin' })
  })

  it('waits for the plugin list before falling back, then falls back', () => {
    const missing = { ...base, requested: ROADMAP, available: [] }
    expect(resolveActivePluginTaskSource({ ...missing, availableReady: false })).toEqual({
      kind: 'pending'
    })
    expect(resolveActivePluginTaskSource(missing)).toEqual({ kind: 'builtin' })
  })
})
