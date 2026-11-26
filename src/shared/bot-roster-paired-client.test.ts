import { describe, expect, it } from 'vitest'
import { formatPairedClient } from './bot-roster'
import { PeerMailPullParams } from './rpc-contract/orchestration/orchestration-peer-mail-params'

describe("a paired computer in a server's bot list", () => {
  it('names the bots it lets this Orca ask, with the --on-client send for them', () => {
    const text = formatPairedClient({
      name: 'MacBook Pro (7)',
      onClient: 'install_a',
      bots: [{ id: 'badf7c5c', name: "Jinjing's CoS" }]
    })
    expect(text).toContain('"MacBook Pro (7)": a computer paired to this Orca, connected now')
    expect(text).toContain('--on-client install_a')
    expect(text).toContain(`"bot:Jinjing's CoS" (id address: bot:badf7c5c)`)
    expect(text).toContain('orca orchestration send --on-client install_a --to bot:<id>')
  })

  it('with none it lets this Orca ask, says how its owner makes one askable', () => {
    const text = formatPairedClient({ name: 'MacBook Pro (7)', onClient: 'install_a', bots: [] })
    expect(text).toContain('None of its bots are listed')
    expect(text).toContain('@-mentions that bot in your chat from that computer')
    expect(text).toContain('Who can ask')
  })
})

describe('the bots a paired computer names on its pull', () => {
  const pull = (bots: unknown) =>
    PeerMailPullParams.parse({
      clientAsks: { session: 's', installationId: 'install_a', name: 'Mac', bots }
    }).clientAsks

  it('keeps a well-formed list', () => {
    expect(pull([{ id: 'docs-1', name: 'Docs' }])?.bots).toEqual([{ id: 'docs-1', name: 'Docs' }])
  })

  it('drops a malformed list without refusing the pull', () => {
    expect(pull([{ id: 'bad id; rm -rf', name: 'Docs' }])).toEqual({
      session: 's',
      installationId: 'install_a',
      name: 'Mac'
    })
    expect(pull('nope')?.installationId).toBe('install_a')
  })
})
