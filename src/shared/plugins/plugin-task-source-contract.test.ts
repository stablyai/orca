import { describe, expect, it } from 'vitest'
import {
  pluginTaskCommentSchema,
  pluginTaskCreateSchema,
  pluginTaskFacetOptionQuerySchema,
  pluginTaskFacetSchema,
  pluginTaskItemDetailSchema,
  pluginTaskItemSchema,
  pluginTaskItemTypeQuerySchema,
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
        create: false,
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
        create: false,
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

  describe('composable filter facets', () => {
    const status = {
      connected: true,
      accountLabel: 'Ada Lovelace',
      notice: null,
      supports: {
        create: false,
        comment: true,
        transition: true,
        assign: false,
        editTitle: false,
        editDescription: false
      }
    }
    const state = {
      id: 'state',
      label: 'State',
      kind: 'multi',
      options: [
        { id: 'Active', label: 'Active' },
        { id: 'Ready', label: 'Ready' }
      ]
    }
    const query = { scopeIds: [], search: null, cursor: null, limit: 50 }

    it('accepts a status declaring facets, one declaring only filters, and one declaring both', () => {
      const filters = [{ id: 'assigned', label: 'Assigned to me' }]
      const presetsOnly = pluginTaskSourceStatusSchema.safeParse({ ...status, filters })
      const both = pluginTaskSourceStatusSchema.safeParse({ ...status, filters, facets: [state] })

      expect(pluginTaskSourceStatusSchema.safeParse({ ...status, facets: [state] }).success).toBe(
        true
      )
      // Carry-through, not acceptance: a dropped `filters` still parses, because
      // the schema strips what it does not declare, and an older host sends
      // nothing else.
      expect(presetsOnly.success && presetsOnly.data.filters).toEqual(filters)
      expect(both.success && both.data.filters).toEqual(filters)
    })

    it('accepts a dynamic facet that declares no options', () => {
      expect(
        pluginTaskFacetSchema.safeParse({
          id: 'sprint',
          label: 'Sprint',
          kind: 'single',
          dynamic: true
        }).success
      ).toBe(true)
    })

    it('accepts a facet declaring default options, and one declaring none', () => {
      const defaulted = pluginTaskFacetSchema.safeParse({
        ...state,
        defaultOptionIds: ['Active', 'Ready']
      })

      expect(defaulted.success && defaulted.data.defaultOptionIds).toEqual(['Active', 'Ready'])
      expect(pluginTaskFacetSchema.safeParse(state).success).toBe(true)
      expect(
        pluginTaskFacetSchema.safeParse(state).success &&
          pluginTaskFacetSchema.parse(state).defaultOptionIds
      ).toBeUndefined()
    })

    // A `dynamic` facet resolves its options per scope, so the declaration
    // cannot name them; cross-checking here would refuse every such default.
    it('accepts a default naming an option the facet does not declare', () => {
      expect(
        pluginTaskFacetSchema.safeParse({ ...state, defaultOptionIds: ['Retired'] }).success
      ).toBe(true)
    })

    it('rejects more default options than the cap, and an empty default option id', () => {
      expect(
        pluginTaskFacetSchema.safeParse({
          ...state,
          defaultOptionIds: Array.from({ length: 201 }, (_, i) => `o${i}`)
        }).success
      ).toBe(false)
      expect(pluginTaskFacetSchema.safeParse({ ...state, defaultOptionIds: [''] }).success).toBe(
        false
      )
    })

    it('rejects a facet or option id that is empty or past its cap', () => {
      expect(pluginTaskFacetSchema.safeParse({ ...state, id: '' }).success).toBe(false)
      expect(pluginTaskFacetSchema.safeParse({ ...state, id: 'x'.repeat(513) }).success).toBe(false)
      expect(
        pluginTaskFacetSchema.safeParse({ ...state, options: [{ id: '', label: 'Active' }] })
          .success
      ).toBe(false)
      expect(
        pluginTaskFacetSchema.safeParse({
          ...state,
          options: [{ id: 'Active', label: 'L'.repeat(257) }]
        }).success
      ).toBe(false)
    })

    it('rejects more facets than the cap, and more options within one than the cap', () => {
      expect(
        pluginTaskSourceStatusSchema.safeParse({
          ...status,
          facets: Array.from({ length: 9 }, (_, i) => ({ ...state, id: `f${i}` }))
        }).success
      ).toBe(false)
      expect(
        pluginTaskFacetSchema.safeParse({
          ...state,
          options: Array.from({ length: 201 }, (_, i) => ({ id: `o${i}`, label: `Option ${i}` }))
        }).success
      ).toBe(false)
    })

    it('accepts a query with facetSelections, one with only filterId, and one with both', () => {
      const facetSelections = { state: ['Active', 'Ready'], sprint: ['s-42'] }
      const filterOnly = pluginTaskQuerySchema.safeParse({ ...query, filterId: 'assigned' })
      const both = pluginTaskQuerySchema.safeParse({
        ...query,
        filterId: 'assigned',
        facetSelections
      })

      expect(pluginTaskQuerySchema.safeParse({ ...query, facetSelections }).success).toBe(true)
      // Carry-through, not acceptance: a dropped `filterId` still parses, and an
      // older client sends it alone.
      expect(filterOnly.success && filterOnly.data.filterId).toBe('assigned')
      expect(both.success && both.data.filterId).toBe('assigned')
      expect(both.success && both.data.facetSelections).toEqual(facetSelections)
    })

    it('rejects facetSelections naming more facets than the cap', () => {
      const facetSelections = Object.fromEntries(
        Array.from({ length: 9 }, (_, i) => [`f${i}`, ['a']])
      )

      expect(pluginTaskQuerySchema.safeParse({ ...query, facetSelections }).success).toBe(false)
    })

    it('rejects more selections within one facet than the cap', () => {
      const facetSelections = { state: Array.from({ length: 201 }, (_, i) => `o${i}`) }

      expect(pluginTaskQuerySchema.safeParse({ ...query, facetSelections }).success).toBe(false)
    })

    it('rejects an empty facet id or option id in a selection', () => {
      expect(
        pluginTaskQuerySchema.safeParse({ ...query, facetSelections: { '': ['a'] } }).success
      ).toBe(false)
      expect(
        pluginTaskQuerySchema.safeParse({ ...query, facetSelections: { state: [''] } }).success
      ).toBe(false)
    })

    it('leaves a single-kind facet to the source: two selections still validate', () => {
      const facetSelections = { sprint: ['s-41', 's-42'] }

      expect(
        pluginTaskSourceStatusSchema.safeParse({
          ...status,
          facets: [{ id: 'sprint', label: 'Sprint', kind: 'single', dynamic: true }]
        }).success
      ).toBe(true)
      expect(pluginTaskQuerySchema.safeParse({ ...query, facetSelections }).success).toBe(true)
    })

    it('names the facet and the scope selection whose options to offer', () => {
      expect(
        pluginTaskFacetOptionQuerySchema.safeParse({ facetId: 'sprint', scopeIds: ['org/proj'] })
          .success
      ).toBe(true)
      expect(
        pluginTaskFacetOptionQuerySchema.safeParse({ facetId: 'sprint', scopeIds: [] }).success
      ).toBe(true)
      expect(pluginTaskFacetOptionQuerySchema.safeParse({ facetId: 'sprint' }).success).toBe(false)
      expect(
        pluginTaskFacetOptionQuerySchema.safeParse({ facetId: '', scopeIds: [] }).success
      ).toBe(false)
    })

    it('binds listFacetOptions to a bounded option list', () => {
      const schema = PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.listFacetOptions

      expect(schema.safeParse([{ id: 'sprint-42', label: 'Sprint 42' }]).success).toBe(true)
      expect(schema.safeParse([{ id: 'sprint-42', name: 'Sprint 42' }]).success).toBe(false)
      expect(
        schema.safeParse(Array.from({ length: 201 }, (_, i) => ({ id: `o${i}`, label: `O${i}` })))
          .success
      ).toBe(false)
    })
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
        create: false,
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
      'listItemTypes',
      'listFacetOptions',
      'listItems',
      'getItem',
      'createItem',
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
    ['listAssignees', [{ id: 'ada', displayName: 'Ada' }], [{ id: 'ada' }]],
    ['listItemTypes', [{ id: 'Bug', name: 'Bug' }], [{ id: 'Bug' }]],
    ['listFacetOptions', [{ id: 'sprint-42', label: 'Sprint 42' }], [{ id: 'sprint-42' }]]
  ] as const)('binds %s to a schema that rejects the wrong shape', (method, valid, invalid) => {
    const schema = PLUGIN_TASK_SOURCE_RESULT_SCHEMAS[method]

    expect(schema.safeParse(valid).success).toBe(true)
    expect(schema.safeParse(invalid).success).toBe(false)
  })

  it('binds getItem, applyPatch and createItem to the item schema, not a page', () => {
    const page = { items: [], nextCursor: null }

    expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.getItem.safeParse(page).success).toBe(false)
    expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.applyPatch.safeParse(page).success).toBe(false)
    expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.createItem.safeParse(page).success).toBe(false)
  })

  it('requires a source to declare whether it can create, with no default', () => {
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

    expect(pluginTaskSourceStatusSchema.safeParse(status).success).toBe(false)
    expect(
      pluginTaskSourceStatusSchema.safeParse({
        ...status,
        supports: { ...status.supports, create: true }
      }).success
    ).toBe(true)
  })

  it('names the scope whose item types to offer', () => {
    expect(pluginTaskItemTypeQuerySchema.safeParse({ scopeId: 'org/proj' }).success).toBe(true)
    expect(pluginTaskItemTypeQuerySchema.safeParse({}).success).toBe(false)
    expect(pluginTaskItemTypeQuerySchema.safeParse({ scopeId: '' }).success).toBe(false)
  })

  it('accepts a create with and without a description', () => {
    const create = { scopeId: 'org/proj', typeId: 'Bug', title: 'Crash on resume' }

    expect(pluginTaskCreateSchema.safeParse(create).success).toBe(true)
    expect(pluginTaskCreateSchema.safeParse({ ...create, description: 'Steps' }).success).toBe(true)
  })

  it.each([['scopeId'], ['typeId'], ['title']] as const)('rejects a create missing %s', (field) => {
    const create: Record<string, string> = {
      scopeId: 'org/proj',
      typeId: 'Bug',
      title: 'Crash on resume'
    }
    delete create[field]

    expect(pluginTaskCreateSchema.safeParse(create).success).toBe(false)
    expect(
      pluginTaskCreateSchema.safeParse({ ...create, [field]: '' }).success,
      `an empty ${field} is as unusable as a missing one`
    ).toBe(false)
  })

  describe('plugin task item detail schema', () => {
    const base = {
      id: '4821',
      key: '4821',
      title: 'Crash on resume',
      state: { name: 'Active', category: 'in-progress' },
      assignee: null,
      url: null,
      updatedAt: null,
      scopeId: null
    }

    it('accepts a detail with a markdown description', () => {
      expect(
        pluginTaskItemDetailSchema.safeParse({
          ...base,
          description: '**Steps**\n1. Open app',
          descriptionFormat: 'markdown',
          type: 'Bug'
        }).success
      ).toBe(true)
    })

    it('accepts a detail with no description', () => {
      expect(pluginTaskItemDetailSchema.safeParse(base).success).toBe(true)
    })

    it('defaults descriptionFormat to text when omitted', () => {
      const parsed = pluginTaskItemDetailSchema.safeParse({ ...base, description: 'plain text' })

      expect(parsed.success).toBe(true)
      if (parsed.success) {
        expect(parsed.data.descriptionFormat).toBe('text')
      }
    })

    it('rejects an html description format', () => {
      expect(
        pluginTaskItemDetailSchema.safeParse({
          ...base,
          description: '<p>Steps</p>',
          descriptionFormat: 'html'
        }).success
      ).toBe(false)
    })
  })

  describe('plugin task comment schema', () => {
    const base = {
      id: 'c1',
      author: { id: 'ada', displayName: 'Ada Lovelace' },
      body: 'Looks good',
      createdAt: '2026-09-20T10:00:00.000Z'
    }

    it('accepts a comment whose body is markdown', () => {
      expect(
        pluginTaskCommentSchema.safeParse({
          ...base,
          body: '**Steps**\n\n- Open app',
          bodyFormat: 'markdown'
        }).success
      ).toBe(true)
    })

    it('still accepts text and html bodies', () => {
      expect(pluginTaskCommentSchema.safeParse({ ...base, bodyFormat: 'text' }).success).toBe(true)
      expect(
        pluginTaskCommentSchema.safeParse({ ...base, body: '<p>ok</p>', bodyFormat: 'html' })
          .success
      ).toBe(true)
    })

    it('rejects an unknown body format', () => {
      expect(pluginTaskCommentSchema.safeParse({ ...base, bodyFormat: 'adf' }).success).toBe(false)
    })

    it('requires a body format, so a converted body cannot go undeclared', () => {
      expect(pluginTaskCommentSchema.safeParse(base).success).toBe(false)
    })
  })

  it('binds getItem to the detail schema, carrying description through', () => {
    const detail = {
      id: '4821',
      key: '4821',
      title: 'Crash on resume',
      state: { name: 'Active', category: 'in-progress' },
      assignee: null,
      url: null,
      updatedAt: null,
      scopeId: null,
      description: '**Steps**\n1. Open app',
      descriptionFormat: 'markdown',
      type: 'Bug'
    }

    const parsed = PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.getItem.safeParse(detail)

    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data).toMatchObject({
        description: detail.description,
        descriptionFormat: 'markdown',
        type: 'Bug'
      })
    }
  })

  it('keeps listItems bound to the page schema, not the detail shape', () => {
    const page = { items: [], nextCursor: null }

    expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.listItems.safeParse(page).success).toBe(true)
    expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS.getItem.safeParse(page).success).toBe(false)
  })

  describe('every method is pinned to its own schema, not a neighbor', () => {
    // Methods within a group accept structurally identical data, so no fixture
    // can tell which of them a binding points at. Only within-group pairs are
    // excluded from the cross-schema rejection matrix below; every other pair
    // still has to reject.
    const INDISTINGUISHABLE_GROUPS: readonly ReadonlySet<PluginTaskSourceMethod>[] = [
      new Set(['getItem', 'applyPatch', 'createItem']),
      new Set(['listItemTypes', 'listTransitions'])
    ]

    function shareASchema(a: PluginTaskSourceMethod, b: PluginTaskSourceMethod): boolean {
      return INDISTINGUISHABLE_GROUPS.some((group) => group.has(a) && group.has(b))
    }

    const fixtures: Record<PluginTaskSourceMethod, unknown> = {
      status: {
        connected: true,
        accountLabel: 'Ada Lovelace',
        notice: null,
        supports: {
          create: false,
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
      // isDefault with a string value is stripped by the item type schema and
      // fails type-checking under the scope schema, which is otherwise the one
      // other schema a bare id/name pair satisfies.
      listItemTypes: [{ id: 'User Story', name: 'User Story', isDefault: 'not-a-boolean' }],
      listFacetOptions: [{ id: 'sprint-42', label: 'Sprint 42' }],
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
      createItem: {
        id: '5560',
        key: '5560',
        title: 'Add retry budget',
        state: { name: 'New', category: 'todo' },
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
        expect(PLUGIN_TASK_SOURCE_RESULT_SCHEMAS[method].safeParse(fixtures[method]).success).toBe(
          true
        )
      }
    )

    it('rejects every fixture under every other method schema', () => {
      for (const ownMethod of PLUGIN_TASK_SOURCE_METHODS) {
        for (const otherMethod of PLUGIN_TASK_SOURCE_METHODS) {
          if (otherMethod === ownMethod) {
            continue
          }
          if (shareASchema(ownMethod, otherMethod)) {
            continue
          }

          const result = PLUGIN_TASK_SOURCE_RESULT_SCHEMAS[otherMethod].safeParse(
            fixtures[ownMethod]
          )
          expect(result.success, `${ownMethod}'s fixture must fail ${otherMethod}'s schema`).toBe(
            false
          )
        }
      }
    })
  })
})
