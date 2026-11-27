import { describe, expect, it } from 'vitest'
import { PAIRED_CLIENT_BOTS_MAX, PeerMailPullParams } from './orchestration-peer-mail-params'

describe('the bots a paired computer names on its pull', () => {
  const pull = (bots: unknown, moreBots?: unknown) =>
    PeerMailPullParams.parse({
      clientAsks: { session: 's', installationId: 'install_a', name: 'Mac', bots, moreBots }
    }).clientAsks

  it('keeps a well-formed list', () => {
    expect(pull([{ id: 'docs-1', name: 'Docs' }], true)).toMatchObject({
      bots: [{ id: 'docs-1', name: 'Docs' }],
      moreBots: true
    })
  })

  it('drops a malformed list without refusing the pull', () => {
    expect(pull([{ id: 'bad id; rm -rf', name: 'Docs' }], 'yes')).toEqual({
      session: 's',
      installationId: 'install_a',
      name: 'Mac'
    })
    expect(pull('nope')?.installationId).toBe('install_a')
  })

  it('drops a whole list when one entry is malformed or it runs past the cap, so none is half-read', () => {
    const many = Array.from({ length: PAIRED_CLIENT_BOTS_MAX + 1 }, (_, index) => ({
      id: `bot-${index}`,
      name: `Bot ${index}`
    }))
    expect(pull(many)?.bots).toBeUndefined()
    expect(pull([{ id: 'docs', name: 'Docs' }, { id: 'bad id' }])?.bots).toBeUndefined()
  })
})
