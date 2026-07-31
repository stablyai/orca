import { describe, expect, it } from 'vitest'
import {
  hasOnlyFieldNameShapedKeys,
  hasRepeatedEntryShape,
  isApprovedPathFieldName,
  isArrayContainer,
  isFieldNameShaped,
  isMapContainer,
  isPlainObjectShape,
  isSetContainer,
  isWalkableContainer
} from './nested-container-shape'

describe('isFieldNameShaped', () => {
  it('accepts the lowerCamelCase field names this store actually uses', () => {
    for (const key of ['stateHistory', 'diffComments', 'tabs', 'browserUrlHistory']) {
      expect(isFieldNameShaped(key)).toBe(true)
    }
  })

  it('rejects every shape user data takes, because labels ship to Slack', () => {
    for (const key of [
      'my-feature-branch',
      'acme_billing_secret',
      '/Users/someone/repo',
      'C:\\Users\\someone',
      '9f2a1c9e-8b74-4d21-9f0a-6c5e2b7d1a83',
      'API_TOKEN',
      'Repo Name With Spaces',
      'café',
      ''
    ]) {
      expect(isFieldNameShaped(key)).toBe(false)
    }
  })

  it('caps key length at 32 so one label cannot crowd the breadcrumb budget', () => {
    expect(isFieldNameShaped(`a${'b'.repeat(31)}`)).toBe(true)
    expect(isFieldNameShaped(`a${'b'.repeat(32)}`)).toBe(false)
  })
})

describe('isApprovedPathFieldName', () => {
  it('allows source-owned labels but rejects arbitrary camelCase user data', () => {
    expect(isApprovedPathFieldName('stateHistory')).toBe(true)
    expect(isApprovedPathFieldName('diffComments')).toBe(true)
    expect(isApprovedPathFieldName('acmeBillingSecret')).toBe(false)
    expect(isApprovedPathFieldName('featureCeoCompModel')).toBe(false)
  })
})

describe('hasRepeatedEntryShape', () => {
  it('calls repeated records a dictionary, so its user-derived keys collapse', () => {
    expect(
      hasRepeatedEntryShape({
        acme_secret: { branches: [1], head: 'x' },
        other_repo: { branches: [2], head: 'y' }
      })
    ).toBe(true)
  })

  it('calls a mixed-field record a struct, so its field names survive', () => {
    expect(hasRepeatedEntryShape({ paneKey: 'p', state: 'idle', stateHistory: [1, 2] })).toBe(false)
  })

  it('treats differing field sets as a struct rather than a dictionary', () => {
    expect(hasRepeatedEntryShape({ a: { x: 1 }, b: { y: 2 } })).toBe(false)
  })

  it('cannot infer repetition from a single entry', () => {
    expect(hasRepeatedEntryShape({ onlyOne: { branches: [1] } })).toBe(false)
  })

  it('collapses keys when the deadline expires before classification', () => {
    expect(hasRepeatedEntryShape({ onlyOne: { branches: [1] } }, () => true)).toBe(true)
  })

  it('treats a struct whose values are arrays as a struct', () => {
    // Arrays carry no field names, so nothing proves the keys are interchangeable.
    expect(hasRepeatedEntryShape({ tabs: [1, 2], panes: [3] })).toBe(false)
  })

  it('assumes keys are data when an entry cannot be read', () => {
    const hostile = {
      get boom(): never {
        throw new Error('nope')
      }
    }

    expect(hasRepeatedEntryShape(hostile)).toBe(true)
  })

  it('ignores field order when matching entry shapes', () => {
    expect(hasRepeatedEntryShape({ a: { x: 1, y: 2 }, b: { y: 3, x: 4 } })).toBe(true)
  })
})

describe('isPlainObjectShape', () => {
  it('rejects class instances, which is what keeps xterm and fibers unreachable', () => {
    class Terminal {
      readonly buffer = {}
    }

    expect(isPlainObjectShape(new Terminal())).toBe(false)
  })

  it('rejects DOM-shaped and React-element-shaped objects that are prototype-plain', () => {
    expect(isPlainObjectShape({ nodeType: 1 })).toBe(false)
    expect(isPlainObjectShape({ $$typeof: Symbol.for('react.element') })).toBe(false)
  })

  it('accepts plain and null-prototype data objects', () => {
    expect(isPlainObjectShape({ a: 1 })).toBe(true)
    expect(isPlainObjectShape(Object.create(null))).toBe(true)
  })

  it('rejects scalars, null, and exotic built-ins', () => {
    for (const value of [null, undefined, 7, 'x', new Promise(() => {}), new Uint8Array(2)]) {
      expect(isPlainObjectShape(value)).toBe(false)
    }
  })
})

describe('isWalkableContainer', () => {
  it('admits arrays, Maps, and plain objects only', () => {
    expect(isWalkableContainer([1])).toBe(true)
    expect(isWalkableContainer(new Map())).toBe(true)
    expect(isWalkableContainer({})).toBe(true)
    // A Set is countable but not walkable: its entries are values, not a shape.
    expect(isWalkableContainer(new Set([1]))).toBe(false)
    expect(isWalkableContainer(new WeakMap())).toBe(false)
  })

  it('rejects collection subclasses whose accessors or iterators can run user code', () => {
    class HostileArray extends Array<unknown> {}
    class HostileMap extends Map<unknown, unknown> {}
    class HostileSet extends Set<unknown> {}

    expect(isArrayContainer(new HostileArray())).toBe(false)
    expect(isMapContainer(new HostileMap())).toBe(false)
    expect(isSetContainer(new HostileSet())).toBe(false)
    expect(isWalkableContainer(new HostileArray())).toBe(false)
    expect(isWalkableContainer(new HostileMap())).toBe(false)
  })
})

describe('hasOnlyFieldNameShapedKeys', () => {
  it('condemns the whole container when one sibling key is user-shaped', () => {
    expect(hasOnlyFieldNameShapedKeys({ myFeature: 1, 'fix/login': 2 })).toBe(false)
  })

  it('accepts a container whose keys are all field names', () => {
    expect(hasOnlyFieldNameShapedKeys({ stateHistory: 1, diffComments: 2 })).toBe(true)
  })

  it('does not authorize keys when the deadline expires before the scan', () => {
    expect(hasOnlyFieldNameShapedKeys({ stateHistory: 1 }, () => true)).toBe(false)
  })
})
