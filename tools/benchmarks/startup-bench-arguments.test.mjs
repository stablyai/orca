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
  '--rounds': { key: 'rounds', type: 'number', integer: true, min: 1 },
  '--keep-events': { key: 'keepEvents', type: 'boolean' }
}
const DEFAULTS = { label: 'run', pairs: 8, rounds: 1, keepEvents: false }

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
      /expects a number >= 0/
    )
  })

  it('rejects a blank numeric value rather than coercing it to zero', () => {
    expect(() => parseFlags(argv('--pairs', '  '), SPEC, DEFAULTS)).toThrow(/expects a number >= 0/)
  })

  it('rejects a negative numeric value', () => {
    expect(() => parseFlags(argv('--pairs', '-1'), SPEC, DEFAULTS)).toThrow(/expects a number >= 0/)
  })

  it('still accepts zero, which several profile flags use to opt out', () => {
    expect(parseFlags(argv('--pairs', '0'), SPEC, DEFAULTS).pairs).toBe(0)
  })

  // Why: a count that silently rounds is worse than one that throws.
  // --iterations 1.5 ran twice and --iterations 0 wrote a result over no launches.
  it('rejects a fractional value for a flag declared as a whole number', () => {
    expect(() => parseFlags(argv('--rounds', '1.5'), SPEC, DEFAULTS)).toThrow(
      /expects a whole number/
    )
  })

  it('enforces a per-flag minimum above zero', () => {
    expect(() => parseFlags(argv('--rounds', '0'), SPEC, DEFAULTS)).toThrow(/expects a number >= 1/)
    expect(parseFlags(argv('--rounds', '1'), SPEC, DEFAULTS).rounds).toBe(1)
  })

  it('leaves fractional values alone for flags that are not counts', () => {
    expect(parseFlags(argv('--pairs', '2.5'), SPEC, DEFAULTS).pairs).toBe(2.5)
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

  // Why: --iterations 0 launched nothing and still wrote a result file whose
  // medians were all null, which reads as a completed benchmark.
  it('requires --iterations to be a whole number of at least one', () => {
    const defaults = { iterations: 5 }
    expect(() => parseFlags(argv('--iterations', '0'), SINGLE_ARM_FLAG_SPEC, defaults)).toThrow(
      /expects a number >= 1/
    )
    expect(() => parseFlags(argv('--iterations', '1.5'), SINGLE_ARM_FLAG_SPEC, defaults)).toThrow(
      /expects a whole number/
    )
    expect(parseFlags(argv('--iterations', '3'), SINGLE_ARM_FLAG_SPEC, defaults).iterations).toBe(3)
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
