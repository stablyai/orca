import { describe, expect, it } from 'vitest'
import {
  pluginTaskItemSchema,
  pluginTaskSourceResultSchema,
  pluginTaskSourceStatusSchema,
  PLUGIN_TASK_SOURCE_METHODS,
  PLUGIN_TASK_SOURCE_RESULT_SCHEMAS
} from './plugin-task-source-contract'

describe('plugin task source contract', () => {
  it('accepts a well-formed item and rejects an unknown state category', () => {
    const item = {
      id: '4821',
      key: '4821',
      title: 'Crash on resume',
      state: { name: 'Active', category: 'in-progress' },
      assignee: null,
      url: 'https://dev.azure.com/org/proj/_workitems/edit/4821',
      updatedAt: '2026-09-20T10:00:00.000Z',
      scopeId: 'proj'
    }

    expect(pluginTaskItemSchema.safeParse(item).success).toBe(true)
    expect(
      pluginTaskItemSchema.safeParse({ ...item, state: { name: 'Active', category: 'nope' } })
        .success
    ).toBe(false)
  })

  it('discriminates ok results from failures on a closed error code set', () => {
    const schema = pluginTaskSourceResultSchema(pluginTaskItemSchema.array())

    expect(schema.safeParse({ ok: true, data: [] }).success).toBe(true)
    expect(
      schema.safeParse({ ok: false, code: 'unauthorized', message: 'token expired' }).success
    ).toBe(true)
    expect(schema.safeParse({ ok: false, code: 'teapot', message: 'no' }).success).toBe(false)
  })

  it('treats a connected status with a notice as distinct from a failure', () => {
    const parsed = pluginTaskSourceStatusSchema.safeParse({
      connected: true,
      accountLabel: 'Ada Lovelace',
      notice: { code: 'unavailable', message: 'scope cache is stale' },
      supports: {
        comment: true,
        transition: true,
        assign: false,
        editTitle: false,
        editDescription: false
      }
    })

    expect(parsed.success).toBe(true)
  })

  it('names every method the invoker dispatches', () => {
    expect([...PLUGIN_TASK_SOURCE_METHODS]).toEqual([
      'status',
      'listScopes',
      'listItems',
      'getItem',
      'listComments',
      'addComment',
      'listTransitions',
      'listAssignees',
      'applyPatch'
    ])
  })

  it('gives every method a result schema, so no call can go unvalidated', () => {
    for (const method of PLUGIN_TASK_SOURCE_METHODS) {
      expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS[method]).toBeDefined()
    }
    expect(Object.keys(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS).sort()).toEqual(
      [...PLUGIN_TASK_SOURCE_METHODS].sort()
    )
  })

  it.each([
    ['listItems', { items: [], nextCursor: null }, { items: 'not-an-array' }],
    ['listScopes', [{ id: 'proj', name: 'Project' }], { id: 'proj' }],
    ['listTransitions', [{ id: '2', name: 'Active' }], [{ id: '2' }]],
    ['listAssignees', [{ id: 'ada', displayName: 'Ada' }], [{ id: 'ada' }]]
  ] as const)('binds %s to a schema that rejects the wrong shape', (method, valid, invalid) => {
    const schema = PLUGIN_TASK_SOURCE_RESULT_SCHEMAS[method]

    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse(invalid).success).toBe(false)
  })

  it('binds getItem and applyPatch to the item schema, not a page', () => {
    const page = { items: [], nextCursor: null }

    expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.getItem.safeParse(page).success).toBe(false)
    expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.applyPatch.safeParse(page).success).toBe(false)
  })
})
