import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceLinkedItem } from './workspace-linked-item'

const PLUGIN_ITEM = {
  provider: 'plugin',
  type: 'issue',
  number: 0,
  title: 'AB-41 Ship the detail panel',
  url: 'https://dev.azure.com/contoso/proj/_workitems/edit/41',
  pluginKey: 'nssf.azure-boards',
  sourceId: 'boards'
}

describe('normalizeWorkspaceLinkedItem', () => {
  it('accepts a contributed item and preserves its plugin and source identity', () => {
    expect(normalizeWorkspaceLinkedItem(PLUGIN_ITEM)).toEqual({
      provider: 'plugin',
      type: 'issue',
      number: 0,
      title: 'AB-41 Ship the detail panel',
      url: 'https://dev.azure.com/contoso/proj/_workitems/edit/41',
      pluginKey: 'nssf.azure-boards',
      sourceId: 'boards'
    })
  })

  it('drops blank plugin identity rather than storing empty strings', () => {
    const normalized = normalizeWorkspaceLinkedItem({
      ...PLUGIN_ITEM,
      pluginKey: '  ',
      sourceId: '  '
    })
    expect(normalized).not.toHaveProperty('pluginKey')
    expect(normalized).not.toHaveProperty('sourceId')
  })

  it('still rejects a provider outside the union', () => {
    expect(normalizeWorkspaceLinkedItem({ ...PLUGIN_ITEM, provider: 'azure-boards' })).toBeNull()
  })

  it('rejects a contributed item with no url, which the link cannot resolve without', () => {
    expect(normalizeWorkspaceLinkedItem({ ...PLUGIN_ITEM, url: '   ' })).toBeNull()
  })
})
