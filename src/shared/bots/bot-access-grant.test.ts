import { describe, expect, it } from 'vitest'
import { botAccessGrantFacts } from './bot-access-grant'

const base = { botName: 'Atlas', connector: 'Slack', workspace: 'Acme' }

describe('botAccessGrantFacts', () => {
  it('names one person and their connector identity', () => {
    expect(
      botAccessGrantFacts({ ...base, people: [{ id: 'u1', name: 'Dana', identity: '@dana' }] })
    ).toEqual({ person: 'Dana', count: 1, identity: '@dana' })
  })

  it('names nobody when several people are added', () => {
    expect(
      botAccessGrantFacts({
        ...base,
        people: [
          { id: 'u1', name: 'Dana', identity: '@dana' },
          { id: 'u2', name: 'Lee' }
        ]
      })
    ).toEqual({ person: null, count: 2, identity: null })
  })
})
