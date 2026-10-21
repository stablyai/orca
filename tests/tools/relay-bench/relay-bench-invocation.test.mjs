// Why: every guard in relay-bench-invocation.mjs is the only thing standing between an operator
// typo (or a director that hands back a hostile URL) and live traffic from the operator's host.
// These are the cases that previously slipped through a bare Number() cast or a URL constructor.
import { describe, expect, it, vi } from 'vitest'
import {
  classifyPublicHttpsOrigin,
  isPublicIpAddress,
  parseArgs,
  parseBoundedInteger,
  parsePort,
  requireBoundedInteger,
  requireDirector,
  requireOrigin,
  requirePort,
  resolvesToPublicAddress
} from './relay-bench-invocation.mjs'

/** refuse() exits the process; make that observable instead of killing the test worker. */
function captureRefusal(run) {
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit:${code}`)
  })
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    run()
    return null
  } catch (err) {
    if (!err.message.startsWith('exit:')) {
      throw err
    }
    return { code: Number(err.message.slice('exit:'.length)), message: error.mock.calls[0]?.[0] }
  } finally {
    exit.mockRestore()
    error.mockRestore()
  }
}

describe('parseArgs', () => {
  it('splits flags, options, and positionals', () => {
    const { flags, options, positional } = parseArgs(['run', 'state.json', '--resolve', '--gap=20'])
    expect([...flags]).toEqual(['--resolve'])
    expect(options.get('--gap')).toBe('20')
    expect(positional).toEqual(['run', 'state.json'])
  })

  it('keeps an equals sign inside an option value', () => {
    const { options } = parseArgs(['--director=https://a.example/?x=1'])
    expect(options.get('--director')).toBe('https://a.example/?x=1')
  })
})

describe('parseBoundedInteger', () => {
  it.each(['5', ' 5 ', '0'])('accepts the whole number %s', (value) => {
    expect(parseBoundedInteger(value, { min: 0, max: 10 })).toBe(Number(value.trim()))
  })

  // 'Infinity' is the one that mattered: Number('Infinity') made the run loops never terminate.
  it.each(['Infinity', '-Infinity', 'NaN', '', '   ', 'abc', '1e3', '-1', '1.5', '0x10', '+2'])(
    'rejects %j',
    (value) => {
      expect(parseBoundedInteger(value, { min: 0, max: 10 })).toBeNull()
    }
  )

  it('rejects values outside the bounds', () => {
    expect(parseBoundedInteger('11', { min: 0, max: 10 })).toBeNull()
    expect(parseBoundedInteger('0', { min: 1, max: 10 })).toBeNull()
  })

  it('rejects a non-string', () => {
    expect(parseBoundedInteger(undefined, { min: 0, max: 10 })).toBeNull()
    expect(parseBoundedInteger(5, { min: 0, max: 10 })).toBeNull()
  })
})

describe('requireBoundedInteger', () => {
  it('falls back when the option is absent', () => {
    expect(
      requireBoundedInteger(undefined, '--runs', 'usage', { min: 1, max: 10, fallback: 5 })
    ).toBe(5)
  })

  it('exits 2 on Infinity rather than looping forever', () => {
    const refusal = captureRefusal(() =>
      requireBoundedInteger('Infinity', '--runs', 'usage', { min: 1, max: 10, fallback: 5 })
    )
    expect(refusal?.code).toBe(2)
    expect(refusal?.message).toContain('--runs must be a whole number 1-10')
  })
})

describe('parsePort', () => {
  it('accepts a decimal port', () => {
    expect(parsePort('9222')).toBe(9222)
  })

  // WHATWG URL reads '80@attacker.example' as userinfo, so the fetch would leave loopback.
  it.each(['80@attacker.example', '0', '65536', '9222 9223', 'Infinity', ''])(
    'rejects %j',
    (value) => {
      expect(parsePort(value)).toBeNull()
    }
  )

  it('exits 2 through requirePort', () => {
    expect(
      captureRefusal(() => requirePort('80@attacker.example', 'devtools port', 'usage'))?.code
    ).toBe(2)
  })
})

describe('isPublicIpAddress', () => {
  it.each([
    '127.0.0.1',
    '127.1.2.3',
    '0.0.0.0',
    '10.0.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1'
  ])('refuses %s', (host) => {
    expect(isPublicIpAddress(host)).toBe(false)
  })

  it.each(['8.8.8.8', '172.32.0.1', '172.15.0.1', '1.1.1.1', '2001:db8::1', '::ffff:8.8.8.8'])(
    'allows %s',
    (host) => {
      expect(isPublicIpAddress(host)).toBe(true)
    }
  )

  it('reports null for a DNS name', () => {
    expect(isPublicIpAddress('relay.example')).toBeNull()
  })
})

describe('classifyPublicHttpsOrigin', () => {
  it('normalizes an accepted origin', () => {
    expect(classifyPublicHttpsOrigin('https://relay.example/health?x=1')).toEqual({
      ok: true,
      origin: 'https://relay.example'
    })
  })

  it.each([
    ['http://relay.example', 'must be an https origin'],
    ['wss://relay.example', 'must be an https origin'],
    ['https://user:pass@relay.example', 'must not carry credentials'],
    ['https://localhost:9222', 'loopback'],
    ['https://app.localhost', 'loopback'],
    ['https://127.0.0.1:8080', 'loopback, link-local, or private'],
    ['https://[::1]/', 'loopback, link-local, or private'],
    ['https://[::ffff:127.0.0.1]/', 'loopback, link-local, or private'],
    ['https://169.254.169.254/latest/meta-data', 'loopback, link-local, or private'],
    ['https://10.1.2.3', 'loopback, link-local, or private'],
    ['not a url', 'not a URL'],
    ['', 'missing origin']
  ])('refuses %s', (value, reason) => {
    const verdict = classifyPublicHttpsOrigin(value)
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain(reason)
  })
})

describe('resolvesToPublicAddress', () => {
  it('skips the lookup for a literal address', async () => {
    const lookup = vi.fn()
    await expect(resolvesToPublicAddress('https://8.8.8.8', { lookup })).resolves.toEqual({
      ok: true
    })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('refuses a name that resolves into the operator network', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const verdict = await resolvesToPublicAddress('https://relay.example', { lookup })
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('127.0.0.1')
  })

  it('refuses when any resolved address is private', async () => {
    const lookup = vi.fn().mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 }
    ])
    expect((await resolvesToPublicAddress('https://relay.example', { lookup })).ok).toBe(false)
  })

  it('accepts a name that resolves publicly', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    expect(await resolvesToPublicAddress('https://relay.example', { lookup })).toEqual({ ok: true })
  })

  it('refuses when resolution fails', async () => {
    const lookup = vi.fn().mockRejectedValue(new Error('ENOTFOUND'))
    expect((await resolvesToPublicAddress('https://relay.example', { lookup })).ok).toBe(false)
  })
})

describe('requireOrigin and requireDirector', () => {
  it('returns the origin for an https target', () => {
    expect(requireOrigin('https://relay.example/x', 'cell origin', 'usage')).toBe(
      'https://relay.example'
    )
  })

  // http would let an on-path observer read or rewrite the credentials these origins carry.
  it('exits 2 for an http origin', () => {
    const refusal = captureRefusal(() =>
      requireOrigin('http://relay.example', 'cell origin', 'usage')
    )
    expect(refusal?.code).toBe(2)
    expect(refusal?.message).toContain('must be an https origin')
  })

  it('exits 2 when the director origin is missing', () => {
    const previous = process.env.ORCA_RELAY_BENCH_DIRECTOR
    delete process.env.ORCA_RELAY_BENCH_DIRECTOR
    try {
      expect(captureRefusal(() => requireDirector(new Map(), 'usage'))?.code).toBe(2)
    } finally {
      if (previous !== undefined) {
        process.env.ORCA_RELAY_BENCH_DIRECTOR = previous
      }
    }
  })

  it('reads the director from the flag ahead of the environment', () => {
    expect(requireDirector(new Map([['--director', 'https://d.example']]), 'usage')).toBe(
      'https://d.example'
    )
  })
})
