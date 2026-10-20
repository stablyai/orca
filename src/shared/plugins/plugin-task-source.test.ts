import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugin-manifest'
import { parsePluginTaskSourceResult, pluginTaskListParamsSchema } from './plugin-task-source'

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    id: 'roadmap',
    publisher: 'orca-samples',
    name: 'Roadmap',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    main: 'main.mjs',
    contributes: { taskSources: [{ id: 'plans', title: 'Plans', icon: 'map' }] },
    capabilities: [{ kind: 'tasks:provide' }],
    ...overrides
  }
}

describe('task source manifest contributions', () => {
  it('accepts a worker-backed source with the tasks:provide capability', () => {
    expect(parsePluginManifest(manifest())).toMatchObject({
      ok: true,
      manifest: { contributes: { taskSources: [{ id: 'plans', title: 'Plans', icon: 'map' }] } }
    })
  })

  it('defaults taskSources to empty for manifests that predate them', () => {
    const result = parsePluginManifest(
      manifest({ main: undefined, contributes: { panels: [] }, capabilities: [] })
    )

    expect(result).toMatchObject({ ok: true, manifest: { contributes: { taskSources: [] } } })
  })

  it('requires a worker entry and the tasks:provide capability', () => {
    expect(parsePluginManifest(manifest({ main: undefined }))).toEqual({
      ok: false,
      error: 'main: required when contributes.taskSources is non-empty'
    })
    expect(parsePluginManifest(manifest({ capabilities: [] }))).toEqual({
      ok: false,
      error:
        'capabilities: tasks:provide capability required when contributes.taskSources is non-empty'
    })
  })

  it('rejects duplicate source ids', () => {
    const result = parsePluginManifest(
      manifest({
        contributes: {
          taskSources: [
            { id: 'plans', title: 'Plans' },
            { id: 'plans', title: 'Other plans' }
          ]
        }
      })
    )

    expect(result).toEqual({
      ok: false,
      error: 'contributes.taskSources.1: duplicate taskSources id: plans'
    })
  })
})

describe('task source results', () => {
  it('accepts a full list result with filters and start recipes', () => {
    const result = parsePluginTaskSourceResult('list', {
      items: [
        {
          id: 'plan',
          title: 'Plan title',
          status: { label: 'Waiting review', tone: 'review' },
          priority: 'P2',
          owner: 'someone@example.com',
          labels: ['docs'],
          updatedAt: '2026-10-05',
          start: {
            workspaceName: 'plan',
            agentPrompt: 'Implement the plan.',
            baseRef: 'main',
            projectPath: '/home/me/Work',
            projectSource: 'https://github.com/acme/docs'
          }
        },
        {
          id: 'manual',
          title: 'Manual plan',
          startBlockedReason: 'Manual plans are not for agents'
        }
      ],
      filters: [
        {
          id: 'state',
          label: 'State',
          options: [
            { value: 'open-work', label: 'Open work', count: 3 },
            { value: 'all', label: 'All' }
          ],
          defaultValue: 'open-work'
        }
      ],
      notice: 'Showing cached items'
    })

    expect(result.ok).toBe(true)
  })

  it('names the offending field on failure', () => {
    expect(
      parsePluginTaskSourceResult('list', {
        items: [{ id: 'a', title: 'A', status: { label: 'Open', tone: 'sideways' } }]
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining('items.0.status.tone') })
    expect(parsePluginTaskSourceResult('get', { item: { id: 'a' } })).toMatchObject({
      ok: false,
      error: expect.stringContaining('item.title')
    })
  })

  it('caps the number of selected filters', () => {
    const filters = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`f-${index}`, 'x']))

    expect(pluginTaskListParamsSchema.safeParse({ filters }).success).toBe(false)
  })
})
