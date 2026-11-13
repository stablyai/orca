import { describe, expect, it } from 'vitest'
import { isLinkedToPluginTask, normalizeLinkedPluginTask } from './plugin-task-link'

const LINK = {
  pluginKey: 'orca-samples.roadmap',
  sourceId: 'roadmap',
  itemId: 'plan',
  title: 'Plan title',
  sourceTitle: 'Roadmap',
  metadata: { plan: 'plans/plan.md' }
}

describe('linked plugin task', () => {
  it('keeps a valid link and drops malformed ones', () => {
    expect(normalizeLinkedPluginTask(LINK)).toEqual(LINK)
    expect(normalizeLinkedPluginTask({ ...LINK, pluginKey: 'not a key' })).toBeNull()
    expect(normalizeLinkedPluginTask({ ...LINK, url: 'javascript:alert(1)' })).toBeNull()
    expect(normalizeLinkedPluginTask({ ...LINK, extra: true })).toBeNull()
    expect(normalizeLinkedPluginTask(null)).toBeNull()
  })

  it('matches only the same plugin, source and item', () => {
    const target = { pluginKey: LINK.pluginKey, sourceId: 'roadmap', itemId: LINK.itemId }

    expect(isLinkedToPluginTask(LINK, target)).toBe(true)
    expect(isLinkedToPluginTask(LINK, { ...target, itemId: 'other' })).toBe(false)
    expect(isLinkedToPluginTask(null, target)).toBe(false)
  })
})
