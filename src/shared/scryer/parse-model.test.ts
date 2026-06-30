import { describe, expect, it } from 'vitest'
import { parseModelData } from './parse-model'

describe('parseModelData', () => {
  it('migrates legacy Scryer model fields into the current C4 model shape', () => {
    const parsed = parseModelData(
      JSON.stringify({
        nodes: [
          {
            id: 'n1',
            data: {
              name: 'API',
              description: 'Backend API',
              kind: 'container',
              guidelines: { always: 'Keep handlers small\nReturn JSON', never: ['Leak secrets'] },
              references: [{ pattern: 'src/api/**/*.ts', comment: 'HTTP handlers' }],
              notes: 'Uses Express\nOwns auth',
              status: 'changed'
            }
          },
          {
            id: 'n2',
            position: { x: 40, y: 50 },
            data: {
              name: 'createUser',
              description: 'Create a user',
              kind: 'operation',
              status: 'proposed'
            }
          }
        ],
        edges: [
          { id: 'e1', source: 'n1', target: 'n2', data: { label: 'calls' } },
          { id: 'e1', source: 'n1', target: 'n2', data: { label: 'duplicate' } }
        ],
        scenarios: [
          {
            id: 'flow-1',
            name: 'Signup',
            steps: [{ id: 'b' }, { id: 'a' }],
            transitions: [{ source: 'a', target: 'b' }]
          }
        ]
      })
    )

    expect(parsed.nodes[0]).toMatchObject({
      id: 'n1',
      type: 'c4',
      position: { x: 0, y: 0 },
      data: {
        contract: {
          expect: ['Keep handlers small', 'Return JSON'],
          ask: [],
          never: ['Leak secrets']
        },
        sources: [{ pattern: 'src/api/**/*.ts', comment: 'HTTP handlers' }],
        notes: ['Uses Express', 'Owns auth'],
        status: undefined,
        _needsLayout: true
      }
    })
    expect(parsed.nodes[1].type).toBe('operation')
    expect(parsed.edges).toHaveLength(1)
    expect(parsed.flows?.[0].steps.map((step) => step.id)).toEqual(['a', 'b'])
  })

  it('projects strict Scryer 0.3 models into the C4 task view shape', () => {
    const parsed = parseModelData(
      JSON.stringify({
        version: '0.3',
        nodes: [
          {
            id: 'system',
            kind: 'system',
            name: 'Issue Tracker',
            description: 'Tracks issues',
            appearance: {
              status: 'proposed',
              contract: { expect: ['API tests pass'], ask: [], never: ['Store secrets'] }
            }
          },
          {
            id: 'api',
            kind: 'container',
            name: 'API',
            parentId: 'system',
            appearance: { status: 'proposed' }
          },
          {
            id: 'service',
            kind: 'component',
            name: 'Issue Service',
            parentId: 'api',
            appearance: { status: 'proposed' }
          },
          {
            id: 'create-task',
            kind: 'symbol',
            name: 'createTask',
            parentId: 'service',
            properties: [{ label: 'id', description: 'task id' }],
            appearance: { symbolKind: 'model', status: 'proposed' }
          }
        ],
        links: [{ id: 'edge-api-service', src: 'api', dst: 'service', label: 'uses' }],
        groups: [{ id: 'backend', name: 'Backend', memberIds: ['api', 'missing'] }],
        sourceMap: { service: [{ pattern: 'src/service.ts', line: 2 }] },
        boundaries: { api: [{ pattern: 'src/api/**/*.ts', comment: 'HTTP handlers' }] }
      })
    )

    expect(parsed.nodes.find((node) => node.id === 'system')?.data).toMatchObject({
      kind: 'system',
      status: 'proposed',
      contract: {
        expect: ['API tests pass'],
        ask: [],
        never: ['Store secrets']
      }
    })
    expect(parsed.nodes.find((node) => node.id === 'api')?.data.sources).toEqual([
      { pattern: 'src/api/**/*.ts', comment: 'HTTP handlers' }
    ])
    expect(parsed.nodes.find((node) => node.id === 'create-task')).toMatchObject({
      type: 'model',
      data: {
        kind: 'model',
        status: 'proposed',
        properties: [{ label: 'id', description: 'task id' }]
      }
    })
    expect(parsed.edges).toEqual([
      { id: 'edge-api-service', source: 'api', target: 'service', data: { label: 'uses' } }
    ])
    expect(parsed.groups).toEqual([{ id: 'backend', name: 'Backend', memberIds: ['api'] }])
    expect(parsed.sourceMap).toEqual({ service: [{ pattern: 'src/service.ts', line: 2 }] })
  })

  it('normalizes dirty flow branches, source maps, contracts, groups, and mention warnings', () => {
    const parsed = parseModelData(
      JSON.stringify({
        nodes: [
          {
            id: 'api',
            data: {
              name: 'API',
              description: 'Calls @[Ghost API]',
              kind: 'container',
              contract: {
                expect: [
                  {
                    text: 'Attach evidence',
                    passed: false,
                    url: ' https://example.test/evidence ',
                    image: {
                      filename: 'evidence.png',
                      mimeType: 'image/png',
                      dataUrl: 'data:image/png;base64,abc123'
                    }
                  },
                  {
                    text: 'Ignore malformed image',
                    image: { data: 42 }
                  }
                ]
              }
            }
          }
        ],
        sourceMap: {
          api: [
            { pattern: ' src/api.ts ', line: 8, endLine: 3, command: ' npm test ' },
            { pattern: '' },
            { pattern: 'src/model.ts', line: -2, endLine: 4 }
          ],
          ghost: [{ pattern: 'src/ghost.ts' }]
        },
        groups: [
          { id: 'backend', name: 'Backend', nodeIds: ['api', 'ghost'], kind: 'legacy-group' },
          { id: 42, name: 'Broken', memberIds: 'api' }
        ],
        flows: [
          {
            id: 'flow-1',
            name: 'Dirty Flow',
            steps: [
              {
                id: 'step-1',
                label: 123,
                description: 'Use @[API]',
                branches: [
                  {
                    condition: 99,
                    steps: [{ id: 'branch-step', description: 'Return @[Ghost API]' }]
                  },
                  { condition: 'empty branch', steps: 'not-an-array' }
                ]
              }
            ]
          }
        ]
      })
    )

    expect(parsed.nodes[0].data.contract?.expect[0]).toEqual({
      text: 'Attach evidence',
      passed: false,
      url: 'https://example.test/evidence',
      image: {
        filename: 'evidence.png',
        mimeType: 'image/png',
        data: 'abc123'
      }
    })
    expect(parsed.nodes[0].data.contract?.expect[1]).toEqual({
      text: 'Ignore malformed image'
    })
    expect(parsed.sourceMap).toEqual({
      api: [
        { pattern: 'src/api.ts', line: 3, endLine: 8, command: 'npm test' },
        { pattern: 'src/model.ts', endLine: 4 }
      ]
    })
    expect(parsed.groups).toEqual([{ id: 'backend', name: 'Backend', memberIds: ['api'] }])
    expect(parsed.flows?.[0].steps[0]).toMatchObject({
      id: 'step-1',
      label: '',
      branches: [
        {
          condition: '',
          steps: [{ id: 'branch-step', description: 'Return @[Ghost API]' }]
        },
        {
          condition: 'empty branch',
          steps: []
        }
      ]
    })
    expect(parsed.validationWarnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'missing-mention',
          reference: 'Ghost API',
          path: 'nodes.api.description'
        }),
        expect.objectContaining({
          kind: 'missing-mention',
          reference: 'Ghost API',
          path: 'flows.flow-1.steps.branch-step.description'
        })
      ])
    )
  })
})
