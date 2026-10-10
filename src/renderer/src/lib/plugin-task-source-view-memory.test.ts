// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'

const STORAGE_KEY = 'orca.plugin-task-source-views.v1'

async function freshModule() {
  vi.resetModules()
  return import('./plugin-task-source-view-memory')
}

beforeEach(() => {
  localStorage.clear()
})

describe('plugin task source view memory', () => {
  it('restores each source view after a reload', async () => {
    const first = await freshModule()
    first.savePluginTaskSourceView('a.b/plans', { query: 'calib', filters: { owner: 'mine' } })
    first.savePluginTaskSourceView('a.b/bugs', { query: '', filters: {} })

    const reloaded = await freshModule()

    expect(reloaded.readPluginTaskSourceView('a.b/plans')).toEqual({
      query: 'calib',
      filters: { owner: 'mine' }
    })
    expect(reloaded.readPluginTaskSourceView('a.b/missing')).toEqual({ query: '', filters: {} })
  })

  it('ignores corrupt or oversized stored values', async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        ['a.b/plans', { query: 7, filters: { owner: 'x'.repeat(300), state: 'open' } }],
        ['broken']
      ])
    )
    const memory = await freshModule()

    expect(memory.readPluginTaskSourceView('a.b/plans')).toEqual({
      query: '',
      filters: { state: 'open' }
    })
  })

  it('keeps working when storage is unavailable', async () => {
    const memory = await freshModule()
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota')
    })

    memory.savePluginTaskSourceView('a.b/plans', { query: 'x', filters: {} })

    expect(memory.readPluginTaskSourceView('a.b/plans').query).toBe('x')
  })
})
