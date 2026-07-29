import { describe, expect, it } from 'vitest'

import {
  assertStateProfile,
  parseFlags,
  PROFILE_FLAG_SPEC,
  SINGLE_ARM_FLAG_SPEC
} from './startup-bench-arguments.mjs'

const SPEC = {
  '--label': { key: 'label', type: 'string' },
  '--pairs': { key: 'pairs', type: 'number' },
  '--keep-events': { key: 'keepEvents', type: 'boolean' }
}
const DEFAULTS = { label: 'run', pairs: 8, keepEvents: false }

// argv[0] and argv[1] are the node binary and script path.
const argv = (...flags) => ['node', 'bench.mjs', ...flags]

describe('parseFlags', () => {
  it('keeps defaults for flags that were not passed', () => {
    expect(parseFlags(argv(), SPEC, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('coerces numeric flags', () => {
    expect(parseFlags(argv('--pairs', '12'), SPEC, DEFAULTS).pairs).toBe(12)
  })

  it('sets boolean flags without consuming the next argument', () => {
    const args = parseFlags(argv('--keep-events', '--label', 'ab'), SPEC, DEFAULTS)
    expect(args.keepEvents).toBe(true)
    expect(args.label).toBe('ab')
  })

  it('rejects an unknown flag instead of ignoring it', () => {
    expect(() => parseFlags(argv('--nope', '1'), SPEC, DEFAULTS)).toThrow(
      /Unknown argument: --nope/
    )
  })

  it('rejects a non-numeric value rather than storing NaN', () => {
    expect(() => parseFlags(argv('--pairs', 'many'), SPEC, DEFAULTS)).toThrow(
      /expects a non-negative number/
    )
  })

  it('rejects a blank numeric value rather than coercing it to zero', () => {
    expect(() => parseFlags(argv('--pairs', '  '), SPEC, DEFAULTS)).toThrow(
      /expects a non-negative number/
    )
  })

  it('rejects a negative numeric value', () => {
    expect(() => parseFlags(argv('--pairs', '-1'), SPEC, DEFAULTS)).toThrow(
      /expects a non-negative number/
    )
  })

  it('still accepts zero, which several profile flags use to opt out', () => {
    expect(parseFlags(argv('--pairs', '0'), SPEC, DEFAULTS).pairs).toBe(0)
  })

  it('rejects a value flag left dangling at the end', () => {
    expect(() => parseFlags(argv('--label'), SPEC, DEFAULTS)).toThrow(/Missing value for --label/)
  })

  it('does not mutate the caller defaults', () => {
    parseFlags(argv('--pairs', '24'), SPEC, DEFAULTS)
    expect(DEFAULTS.pairs).toBe(8)
  })
})

describe('flag specs', () => {
  // Why: the A/B bench spreads the profile spec. If --iterations leaked back in,
  // it would parse there and do nothing, since that bench counts --pairs.
  it('keeps --iterations out of the shared profile spec', () => {
    expect(PROFILE_FLAG_SPEC['--iterations']).toBeUndefined()
    expect(SINGLE_ARM_FLAG_SPEC['--iterations']).toBeDefined()
  })

  it('rejects --iterations when a spec built from the profile flags does not opt in', () => {
    expect(() => parseFlags(argv('--iterations', '12'), PROFILE_FLAG_SPEC, {})).toThrow(
      /Unknown argument: --iterations/
    )
  })
})

describe('assertStateProfile', () => {
  it('accepts the supported profiles', () => {
    expect(() => assertStateProfile('none')).not.toThrow()
    expect(() => assertStateProfile('restored-local-tabs')).not.toThrow()
  })

  it('rejects anything else', () => {
    expect(() => assertStateProfile('restored')).toThrow(/Unknown state profile/)
  })
})
