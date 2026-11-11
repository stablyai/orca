import { describe, expect, it } from 'vitest'
import { describeSandboxUnreachableSite } from './sandbox-unreachable-site-state'

const failure = (code: number, validatedUrl: string) => ({ code, validatedUrl })

describe('describeSandboxUnreachableSite', () => {
  it('names an outside host the sandbox could not reach', () => {
    expect(describeSandboxUnreachableSite(failure(-120, 'https://example.com/'), '')).toEqual({
      kind: 'outside',
      host: 'example.com',
      url: 'https://example.com/'
    })
  })

  it('treats loopback as a sandbox server that is not running', () => {
    expect(
      describeSandboxUnreachableSite(failure(-130, 'http://localhost:3000/'), '')
    ).toMatchObject({
      kind: 'sandbox-server',
      host: 'localhost:3000'
    })
    expect(
      describeSandboxUnreachableSite(failure(-121, 'http://127.0.0.1:8123/x'), '')
    ).toMatchObject({
      kind: 'sandbox-server',
      host: '127.0.0.1:8123'
    })
  })

  it('leaves other failures and non-http pages to the normal failure page', () => {
    expect(describeSandboxUnreachableSite(failure(-102, 'http://localhost:3000/'), '')).toBeNull()
    expect(describeSandboxUnreachableSite(failure(-105, 'https://example.com/'), '')).toBeNull()
    expect(describeSandboxUnreachableSite(failure(-120, 'file:///tmp/x.html'), '')).toBeNull()
  })

  it('falls back to the page URL when the failure has none', () => {
    expect(
      describeSandboxUnreachableSite(failure(-120, ''), 'https://docs.example.org/a')
    ).toMatchObject({
      host: 'docs.example.org'
    })
  })
})
