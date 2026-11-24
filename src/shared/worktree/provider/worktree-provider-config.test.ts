import { describe, expect, it } from 'vitest'
import {
  canonicalWorktreeProviderConfig,
  parseWorktreeProviders,
  worktreeProviderConfigHash,
  worktreeProviderNameConflicts
} from './worktree-provider-config'
import { parseWorktreeProviderClaimResponse } from './worktree-provider-response'
import {
  parseWorktreeProviderTrustFile,
  withWorktreeProviderConfigTrusted
} from './worktree-provider-trust'

const YAML = `
providers:
  wtp:
    claim: ["worktree-pool", "claim", "--json"]
    release: ["worktree-pool", "release"]
    setup: ["worktree-pool", "setup"]
    timeoutSeconds: 120
    workingDirectory: worktree
`

describe('worktree provider config', () => {
  it('parses a provider and applies defaults', () => {
    const parsed = parseWorktreeProviders(YAML, 'user', '/tmp/providers.yaml')
    expect(parsed.diagnostics).toEqual([])
    expect(parsed.providers.get('wtp')).toEqual({
      claim: ['worktree-pool', 'claim', '--json'],
      release: ['worktree-pool', 'release'],
      setup: ['worktree-pool', 'setup'],
      timeoutSeconds: 120,
      workingDirectory: 'worktree'
    })
  })

  it('rejects a missing release command instead of running a half-defined provider', () => {
    const parsed = parseWorktreeProviders(
      'providers:\n  half:\n    claim: ["pool", "claim"]\n',
      'repo',
      '/repo/orca.yaml'
    )
    expect(parsed.providers.size).toBe(0)
    expect(parsed.diagnostics.some((entry) => entry.message.includes('release'))).toBe(true)
  })

  it('rejects shell strings and invalid names', () => {
    const parsed = parseWorktreeProviders(
      'providers:\n  Bad Name:\n    claim: "pool claim"\n    release: ["pool", "release"]\n',
      'user',
      '/tmp/providers.yaml'
    )
    expect(parsed.providers.size).toBe(0)
    expect(parsed.diagnostics.length).toBeGreaterThan(0)
  })

  it('hashes providers stably regardless of YAML key order', () => {
    const first = parseWorktreeProviders(YAML, 'user', '/tmp/a.yaml').providers
    const second = parseWorktreeProviders(
      `providers:
  wtp:
    workingDirectory: worktree
    timeoutSeconds: 120
    setup: ["worktree-pool", "setup"]
    release: ["worktree-pool", "release"]
    claim: ["worktree-pool", "claim", "--json"]
`,
      'user',
      '/tmp/b.yaml'
    ).providers
    expect(canonicalWorktreeProviderConfig(first)).toBe(canonicalWorktreeProviderConfig(second))
    expect(worktreeProviderConfigHash(first)).toBe(worktreeProviderConfigHash(second))
  })

  it('reports names defined by both user and repo config', () => {
    const user = parseWorktreeProviders(YAML, 'user', '/tmp/a.yaml').providers
    const repo = parseWorktreeProviders(YAML, 'repo', '/repo/orca.yaml').providers
    expect(worktreeProviderNameConflicts(user, repo)).toEqual(['wtp'])
  })

  it('requires an approval for the current repo config hash', () => {
    const providers = parseWorktreeProviders(YAML, 'repo', '/repo/orca.yaml').providers
    const hash = worktreeProviderConfigHash(providers)
    const empty = parseWorktreeProviderTrustFile('{"repos":{}}')
    const approved = withWorktreeProviderConfigTrusted(empty, 'repo-1', hash, 123)
    expect(parseWorktreeProviderTrustFile(JSON.stringify(approved)).repos['repo-1']).toEqual({
      contentHash: hash,
      approvedAt: 123
    })
  })
})

describe('worktree provider claim response', () => {
  it('accepts the documented JSON object', () => {
    expect(
      parseWorktreeProviderClaimResponse(
        JSON.stringify({
          path: '/tmp/slot',
          lease_id: 'lease-1',
          profile: 'cone',
          handle: { token: 'abc' }
        })
      )
    ).toEqual({
      ok: true,
      value: {
        path: '/tmp/slot',
        leaseId: 'lease-1',
        profile: 'cone',
        handle: { token: 'abc' }
      }
    })
  })

  it('keeps a lease id when the path is missing so the claim can be released', () => {
    expect(parseWorktreeProviderClaimResponse('{"lease_id":"lease-1"}')).toEqual({
      ok: false,
      reason: 'The claim response must include an absolute "path".',
      leaseId: 'lease-1'
    })
  })

  it('rejects relative paths, arrays and non-JSON output', () => {
    expect(parseWorktreeProviderClaimResponse('{"path":"slot"}').ok).toBe(false)
    expect(parseWorktreeProviderClaimResponse('[]').ok).toBe(false)
    expect(parseWorktreeProviderClaimResponse('Reserving slot...').ok).toBe(false)
  })
})
