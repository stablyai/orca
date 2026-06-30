import { describe, expect, it } from 'vitest'
import type { ArchitectureDiagramModel } from './architecture-diagram-types'
import {
  collectInheritedExpectItems,
  getVerifiedBlockers,
  setContractItemPassed
} from './contract-status'

describe('architecture contract status helpers', () => {
  const model: ArchitectureDiagramModel = {
    nodes: [
      {
        id: 'system',
        data: {
          name: 'Shop',
          description: 'Commerce system',
          kind: 'system',
          contract: {
            expect: [{ text: 'Checkout works', passed: true }],
            ask: [],
            never: []
          }
        }
      },
      {
        id: 'api',
        parentId: 'system',
        data: {
          name: 'API',
          description: 'HTTP API',
          kind: 'container',
          status: 'implemented',
          contract: {
            expect: ['Rate limiting is tested'],
            ask: [],
            never: []
          }
        }
      }
    ],
    links: [],
    sourceMap: {},
    groups: []
  }

  it('collects expect contract items from ancestors and the selected node', () => {
    expect(collectInheritedExpectItems(model, 'api').map((item) => item.text)).toEqual([
      'Checkout works',
      'Rate limiting is tested'
    ])
  })

  it('blocks verified status until every inherited expect item is passed', () => {
    expect(getVerifiedBlockers(model, 'api')).toEqual(['Rate limiting is tested'])
  })

  it('preserves object contract metadata while changing pass/fail state', () => {
    const item = setContractItemPassed(
      { text: 'Screenshot matches', url: 'https://example.com/spec' },
      false
    )

    expect(item).toEqual({
      text: 'Screenshot matches',
      url: 'https://example.com/spec',
      passed: false
    })

    expect(setContractItemPassed('Manual QA complete', true)).toEqual({
      text: 'Manual QA complete',
      passed: true
    })
  })
})
