import { describe, expect, it } from 'vitest'
import {
  orchestrationDeepLinkFromArguments,
  parseOrchestrationDeepLink
} from './orchestration-deep-link'

describe('parseOrchestrationDeepLink', () => {
  it('parses orca://orchestration/new with parameters', () => {
    const result = parseOrchestrationDeepLink(
      'orca://orchestration/new?title=Fix%20bug&repo=my-project&prompt=investigate&objective=stabilize'
    )
    expect(result).toEqual({
      type: 'orchestration-new',
      title: 'Fix bug',
      repo: 'my-project',
      prompt: 'investigate',
      objective: 'stabilize'
    })
  })

  it('parses orca://orchestration/run and orca://orchestration/create aliases', () => {
    expect(
      parseOrchestrationDeepLink('orca://orchestration/run?title=Run%20Intent&repo=demo-engine')
    ).toEqual({
      type: 'orchestration-new',
      title: 'Run Intent',
      repo: 'demo-engine'
    })

    expect(parseOrchestrationDeepLink('orca://orchestration/create?objective=Auto%20Fix')).toEqual({
      type: 'orchestration-new',
      objective: 'Auto Fix'
    })
  })

  it('handles triple slash orca:///orchestration/new links', () => {
    expect(parseOrchestrationDeepLink('orca:///orchestration/new?title=Triple%20Slash')).toEqual({
      type: 'orchestration-new',
      title: 'Triple Slash'
    })
  })

  it('accepts HTTPS links from approved production and localhost hosts', () => {
    expect(
      parseOrchestrationDeepLink('https://app.orca.dev/orchestration/new?title=Prod%20Link')
    ).toEqual({
      type: 'orchestration-new',
      title: 'Prod Link'
    })

    expect(parseOrchestrationDeepLink('http://localhost:5173/orchestration/new?title=Dev')).toEqual(
      {
        type: 'orchestration-new',
        title: 'Dev'
      }
    )
  })

  it('rejects unsafe protocols, invalid origins, and unhandled paths', () => {
    expect(parseOrchestrationDeepLink('')).toBeNull()
    expect(parseOrchestrationDeepLink('not-a-url')).toBeNull()
    expect(parseOrchestrationDeepLink('javascript:alert(1)')).toBeNull()
    expect(parseOrchestrationDeepLink('file:///etc/passwd')).toBeNull()
    expect(parseOrchestrationDeepLink('data:text/plain,hello')).toBeNull()
    expect(
      parseOrchestrationDeepLink('https://attacker.test/orchestration/new?title=evil')
    ).toBeNull()
    expect(parseOrchestrationDeepLink('orca://unknown/action')).toBeNull()
    expect(parseOrchestrationDeepLink('orca://skills/share/share_123')).toBeNull()
  })

  it('rejects surplus path segments on both orca:// and https:// links', () => {
    expect(parseOrchestrationDeepLink('orca://orchestration/new/extra?title=x')).toBeNull()
    expect(
      parseOrchestrationDeepLink('https://app.orca.dev/orchestration/new/extra?title=x')
    ).toBeNull()
    expect(parseOrchestrationDeepLink('orca://orchestration')).toBeNull()
  })
})

describe('orchestrationDeepLinkFromArguments', () => {
  it('extracts matching deep link from process argv array', () => {
    const argv = [
      '/path/to/orca',
      '--some-flag',
      'orca://orchestration/new?title=From%20Argv&repo=my-project'
    ]
    expect(orchestrationDeepLinkFromArguments(argv)).toEqual({
      type: 'orchestration-new',
      title: 'From Argv',
      repo: 'my-project'
    })
  })

  it('returns null when no matching argument is present', () => {
    expect(orchestrationDeepLinkFromArguments([])).toBeNull()
    expect(orchestrationDeepLinkFromArguments(['orca', '--hidden'])).toBeNull()
    expect(orchestrationDeepLinkFromArguments(['orca', 'orca://skills/share/share_123'])).toBeNull()
  })
})
