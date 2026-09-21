import { describe, expect, it } from 'vitest'
import {
  pluginTaskItemSchema,
  pluginTaskQuerySchema,
  pluginTaskSourceResultSchema,
  pluginTaskSourceStatusSchema,
  PLUGIN_TASK_SOURCE_METHODS,
  PLUGIN_TASK_SOURCE_RESULT_SCHEMAS,
  type PluginTaskSourceMethod
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

  it('accepts an item with priority and labels, and one without either', () => {
    const item = {
      id: '4821',
      key: '4821',
      title: 'Crash on resume',
      state: { name: 'Active', category: 'in-progress' },
      assignee: null,
      url: null,
      updatedAt: null,
      scopeId: null
    }

    expect(
      pluginTaskItemSchema.safeParse({ ...item, priority: 'High', labels: ['bug', 'p1'] }).success
    ).toBe(true)
    expect(pluginTaskItemSchema.safeParse(item).success).toBe(true)
  })

  it('rejects more labels than the cap and a label past its length cap', () => {
    const item = {
      id: '4821',
      key: '4821',
      title: 'Crash on resume',
      state: { name: 'Active', category: 'in-progress' },
      assignee: null,
      url: null,
      updatedAt: null,
      scopeId: null
    }

    expect(
      pluginTaskItemSchema.safeParse({ ...item, labels: Array.from({ length: 33 }, () => 'x') })
        .success
    ).toBe(false)
    expect(pluginTaskItemSchema.safeParse({ ...item, labels: ['x'.repeat(129)] }).success).toBe(
      false
    )
  })

  it('accepts a status with declared filters, and one without any', () => {
    const status = {
      connected: true,
      accountLabel: 'Ada Lovelace',
      notice: null,
      supports: {
        comment: true,
        transition: true,
        assign: false,
        editTitle: false,
        editDescription: false
      }
    }

    expect(
      pluginTaskSourceStatusSchema.safeParse({
        ...status,
        filters: [{ id: 'assigned', label: 'Assigned to me' }]
      }).success
    ).toBe(true)
    expect(pluginTaskSourceStatusSchema.safeParse(status).success).toBe(true)
  })

  it('rejects a status with more filters than the cap', () => {
    const status = {
      connected: true,
      accountLabel: 'Ada Lovelace',
      notice: null,
      supports: {
        comment: true,
        transition: true,
        assign: false,
        editTitle: false,
        editDescription: false
      },
      filters: Array.from({ length: 17 }, (_, i) => ({ id: `f${i}`, label: `Filter ${i}` }))
    }

    expect(pluginTaskSourceStatusSchema.safeParse(status).success).toBe(false)
  })

  it('accepts a query with filterId set, and one that omits it', () => {
    const query = { scopeIds: [], search: null, cursor: null, limit: 50 }

    expect(pluginTaskQuerySchema.safeParse({ ...query, filterId: 'assigned' }).success).toBe(true)
    expect(pluginTaskQuerySchema.safeParse(query).success).toBe(true)
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

  describe('every method is pinned to its own schema, not a neighbor', () => {
    // getItem and applyPatch both legitimately use pluginTaskItemSchema, so no
    // fixture can tell which of the two a binding points at; that pair is
    // excluded from the cross-schema rejection matrix below.
    const SHARED_SCHEMA_METHODS = new Set<PluginTaskSourceMethod>(['getItem', 'applyPatch'])

    const fixtures: Record<PluginTaskSourceMethod, unknown> = {
      status: {
        connected: true,
        accountLabel: 'Ada Lovelace',
        notice: null,
        supports: {
          comment: true,
          transition: true,
          assign: true,
          editTitle: true,
          editDescription: true
        }
      },
      // isDefault plus a name past transition's 256-char cap: valid as a
      // scope, invalid as a transition on both counts.
      listScopes: [{ id: 'proj', name: 'P'.repeat(300), isDefault: true }],
      listItems: { items: [], nextCursor: null },
      getItem: {
        id: '4821',
        key: '4821',
        title: 'Crash on resume',
        state: { name: 'Active', category: 'in-progress' },
        assignee: null,
        url: null,
        updatedAt: null,
        scopeId: null
      },
      listComments: [
        {
          id: 'c1',
          author: { id: 'ada', displayName: 'Ada Lovelace' },
          body: 'Looks good',
          bodyFormat: 'text',
          createdAt: '2026-09-20T10:00:00.000Z'
        }
      ],
      addComment: {
        id: 'c1',
        author: { id: 'ada', displayName: 'Ada Lovelace' },
        body: 'Looks good',
        bodyFormat: 'text',
        createdAt: '2026-09-20T10:00:00.000Z'
      },
      // isDefault isn't part of the transition schema, so it's stripped here;
      // it IS part of the scope schema, where a string value fails
      // type-checking, so this fixture is invalid as a scope.
      listTransitions: [{ id: '2', name: 'Active', isDefault: 'not-a-boolean' }],
      listAssignees: [{ id: 'ada', displayName: 'Ada Lovelace', avatarUrl: null }],
      applyPatch: {
        id: '9102',
        key: '9102',
        title: 'Add retry budget',
        state: { name: 'Done', category: 'done' },
        assignee: null,
        url: null,
        updatedAt: null,
        scopeId: null
      }
    }

    it.each(PLUGIN_TASK_SOURCE_METHODS.map((method) => [method] as const))(
      '%s fixture satisfies its own schema',
      (method) => {
        expect(
          PLUGIN_TASK_SOURCE_RESULT_SCHEMAS[method].safeParse(fixtures[method]).success
        ).toBe(true)
      }
    )

    it('rejects every fixture under every other method schema', () => {
      for (const ownMethod of PLUGIN_TASK_SOURCE_METHODS) {
        for (const otherMethod of PLUGIN_TASK_SOURCE_METHODS) {
          if (otherMethod === ownMethod) {
            continue
          }
          if (SHARED_SCHEMA_METHODS.has(ownMethod) && SHARED_SCHEMA_METHODS.has(otherMethod)) {
            continue
          }

          const result = PLUGIN_TASK_SOURCE_RESULT_SCHEMAS[otherMethod].safeParse(
            fixtures[ownMethod]
          )
          expect(
            result.success,
            `${ownMethod}'s fixture must fail ${otherMethod}'s schema`
          ).toBe(false)
        }
      }
    })
  })
})
