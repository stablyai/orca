// Why: the region catalog comes from the director, so it names the destinations this harness
// fetches. Without vetting, a compromised or spoofed director aims the operator's own host at
// loopback and private networks, and `redirect: 'error'` never constrains the first request.
// The all-probes-failed case is here because Math.min of nothing is Infinity, which spread into
// NaN and made an unreachable region report 'ok'.
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sampleRegion, vetProbeOrigins } from './region-probe-replay.mjs'

const servers = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((res) => server.close(res))))
})

/** A real listener, so "no request reached it" is observed rather than assumed. */
async function loopbackListener() {
  const received = []
  const server = createServer((req, res) => {
    received.push(req.url)
    res.end('ok')
  })
  servers.push(server)
  await new Promise((res) => server.listen(0, '127.0.0.1', res))
  return { port: server.address().port, received }
}

describe('vetProbeOrigins', () => {
  it('refuses every non-https and non-public origin the director offers', async () => {
    const { allowed, refused } = await vetProbeOrigins({
      region: 'test',
      probeOrigins: [
        'http://relay.example',
        'https://127.0.0.1:8443',
        'https://localhost:8443',
        'https://[::1]:8443',
        'https://169.254.169.254',
        'https://10.0.0.4'
      ]
    })
    expect(allowed).toEqual([])
    expect(refused).toHaveLength(6)
  })

  it('keeps a public https origin and consults DNS for a name', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const { allowed, refused } = await vetProbeOrigins(
      { region: 'test', probeOrigins: ['https://relay.example/health'] },
      { lookup }
    )
    expect(allowed).toEqual(['https://relay.example'])
    expect(refused).toEqual([])
    expect(lookup).toHaveBeenCalledWith('relay.example', { all: true })
  })

  it('refuses a public-looking name that resolves into the operator network', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    const { allowed } = await vetProbeOrigins(
      { region: 'test', probeOrigins: ['https://rebound.example'] },
      { lookup }
    )
    expect(allowed).toEqual([])
  })

  it('tolerates a region with no probe origins', async () => {
    expect(await vetProbeOrigins({ region: 'test' })).toEqual({ allowed: [], refused: [] })
  })
})

describe('sampleRegion', () => {
  it('sends no request to a loopback listener the director named', async () => {
    const listener = await loopbackListener()
    const result = await sampleRegion({
      region: 'evil',
      probeOrigins: [`http://127.0.0.1:${listener.port}`, `https://127.0.0.1:${listener.port}`]
    })
    expect(listener.received).toEqual([])
    expect(result.verdict).toBe('REFUSED (no allowed probe origin)')
    expect(result.median).toBeNull()
  })

  it('reports unreachable instead of ok when every probe fails', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const probe = vi.fn().mockResolvedValue(null)
    const result = await sampleRegion(
      { region: 'far', probeOrigins: ['https://relay.example'] },
      { lookup, probe }
    )
    expect(result.verdict).toBe('UNREACHABLE (every probe failed)')
    expect(result.median).toBeNull()
    expect(result.spread).toBeNull()
    expect(Number.isFinite(result.median)).toBe(false)
  })

  it('ranks a region whose probes answer consistently', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const latencies = [30, 31, 32]
    const probe = vi.fn(() => Promise.resolve(latencies.shift()))
    const result = await sampleRegion(
      { region: 'near', probeOrigins: ['https://relay.example'] },
      { lookup, probe }
    )
    expect(result).toMatchObject({
      region: 'near',
      samples: [30, 31, 32],
      median: 31,
      spread: 2,
      verdict: 'ok'
    })
  })

  it('applies the shipped spread rule to an inconsistent region', async () => {
    const lookup = vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const latencies = [10, 500, 12]
    const probe = vi.fn(() => Promise.resolve(latencies.shift()))
    const result = await sampleRegion(
      { region: 'jittery', probeOrigins: ['https://relay.example'] },
      { lookup, probe }
    )
    expect(result.verdict).toBe('REJECTED (spread)')
  })
})
