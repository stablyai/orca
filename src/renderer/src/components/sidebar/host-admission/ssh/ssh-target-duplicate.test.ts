import { describe, expect, it } from 'vitest'
import { isDuplicateSshTarget, type SshTargetIdentity } from './ssh-target-duplicate'

type Candidate = Parameters<typeof isDuplicateSshTarget>[1]

function savedTarget(
  fields: Partial<SshTargetIdentity> & Pick<SshTargetIdentity, 'host'>
): SshTargetIdentity {
  return {
    label: fields.host,
    configHost: fields.host,
    port: 22,
    username: '',
    source: 'manual',
    ...fields
  }
}

function candidate(fields: Partial<Candidate> & Pick<Candidate, 'host'>): Candidate {
  return { configHost: fields.host, port: 22, username: '', ...fields }
}

describe('isDuplicateSshTarget', () => {
  it('tells apart unaliased hosts on one gateway by port (issue #51036)', () => {
    const existing = [savedTarget({ host: '127.0.0.1', port: 22101, label: '127.0.0.1:22101' })]

    expect(isDuplicateSshTarget(existing, candidate({ host: '127.0.0.1', port: 22102 }))).toBe(
      false
    )
  })

  it('refuses the exact same endpoint', () => {
    const existing = [savedTarget({ host: '127.0.0.1', port: 22101, label: '127.0.0.1:22101' })]

    expect(isDuplicateSshTarget(existing, candidate({ host: '127.0.0.1', port: 22101 }))).toBe(true)
  })

  it('tells apart different explicit users on one host', () => {
    const existing = [savedTarget({ host: '10.0.0.5', username: 'alice' })]

    expect(isDuplicateSshTarget(existing, candidate({ host: '10.0.0.5', username: 'bob' }))).toBe(
      false
    )
  })

  it('treats a saved port 22 as any port because ssh -G may supply the real one', () => {
    const existing = [savedTarget({ host: '127.0.0.1', port: 22 })]

    expect(isDuplicateSshTarget(existing, candidate({ host: '127.0.0.1', port: 22101 }))).toBe(true)
  })

  it('keeps an imported config Host without HostName owning its name on any port', () => {
    const existing = [savedTarget({ host: 'devbox', port: 2222, source: 'ssh-config' })]

    for (const port of [22, 2222, 3333]) {
      expect(isDuplicateSshTarget(existing, candidate({ host: 'devbox', port }))).toBe(true)
    }
    expect(isDuplicateSshTarget(existing, candidate({ host: 'devbox', username: 'bob' }))).toBe(
      true
    )
  })

  it('refuses a host that matches a manual target label', () => {
    const existing = [savedTarget({ host: '10.0.0.9', label: 'devbox' })]

    expect(isDuplicateSshTarget(existing, candidate({ host: 'DevBox', port: 2200 }))).toBe(true)
  })

  it('refuses an alias that is already in Orca', () => {
    const existing = [savedTarget({ host: '10.0.0.1', configHost: 'gw', label: 'Gateway' })]

    expect(
      isDuplicateSshTarget(existing, candidate({ host: '10.0.0.1', configHost: 'gw', port: 2200 }))
    ).toBe(true)
    expect(isDuplicateSshTarget(existing, candidate({ host: 'gw' }))).toBe(true)
  })
})
