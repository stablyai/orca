import { describe, expect, it } from 'vitest'
import {
  createPluginExtensionRegistry,
  PLUGIN_TASK_SOURCE_EXTENSION_POINT
} from './plugin-extension-registry'

describe('task source extension point', () => {
  it('resolves a registered source by plugin and provider id', async () => {
    const registry = createPluginExtensionRegistry()
    // Registered first, under the same plugin id, to prove resolve addresses
    // by providerId rather than returning the first match for the plugin.
    registry.register(
      PLUGIN_TASK_SOURCE_EXTENSION_POINT,
      'acme.boards',
      { sourceId: 'jira-boards', call: async () => ({ ok: true, data: 'jira' }) },
      'jira-boards'
    )
    registry.register(
      PLUGIN_TASK_SOURCE_EXTENSION_POINT,
      'acme.boards',
      { sourceId: 'azure-boards', call: async () => ({ ok: true, data: null }) },
      'azure-boards'
    )

    const resolved = registry.resolve(
      PLUGIN_TASK_SOURCE_EXTENSION_POINT,
      'acme.boards',
      'azure-boards'
    )

    expect(resolved?.sourceId).toBe('azure-boards')
    await expect(resolved?.call('status')).resolves.toEqual({ ok: true, data: null })
  })

  it('drops a plugin\'s sources when the plugin is cleared', () => {
    const registry = createPluginExtensionRegistry()
    registry.register(
      PLUGIN_TASK_SOURCE_EXTENSION_POINT,
      'acme.boards',
      { sourceId: 'azure-boards', call: async () => ({ ok: true as const, data: null }) },
      'azure-boards'
    )

    registry.clearPlugin('acme.boards')

    expect(registry.resolveAll(PLUGIN_TASK_SOURCE_EXTENSION_POINT)).toEqual([])
  })
})
