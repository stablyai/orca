import { describe, expect, it } from 'vitest'
import { botToolAppNeedsOwner } from './bot-connector-entries'

const signedIn = {
  name: 'notion',
  detail: 'https://mcp.notion.com/mcp',
  remote: false,
  signIn: { state: 'signed-in' as const, limited: false }
}
const app = (problem?: { kind: 'failed' | 'unconfirmed' | 'sign-in'; reason?: 'nameTaken' }) => ({
  tool: signedIn,
  app: null,
  problem
})

describe('botToolAppNeedsOwner', () => {
  it('counts a signed-in app that won’t start, a taken name or another failure', () => {
    expect(botToolAppNeedsOwner(app({ kind: 'failed', reason: 'nameTaken' }))).toBe(true)
    expect(botToolAppNeedsOwner(app({ kind: 'failed' }))).toBe(true)
  })

  it('leaves out a working or unconfirmed signed-in app: there is nothing for the owner to do', () => {
    expect(botToolAppNeedsOwner(app())).toBe(false)
    expect(botToolAppNeedsOwner(app({ kind: 'unconfirmed' }))).toBe(false)
  })

  it('still counts a sign-in that was lost', () => {
    expect(
      botToolAppNeedsOwner({ ...app(), tool: { ...signedIn, signIn: { state: 'lost' as const } } })
    ).toBe(true)
  })
})
