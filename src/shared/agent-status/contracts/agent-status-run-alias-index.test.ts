import { describe, expect, it, vi } from 'vitest'
import {
  deserializeAgentStatusRunAliasIndex,
  serializeAgentStatusProviderAliasKey,
  serializeAgentStatusRunAliasIndex,
  type AgentStatusScopedProviderAlias,
  type AgentStatusRunAliasIndex
} from './agent-status-run-alias-index'
import type { AgentStatusExecutionScope } from './agent-status-subject'

function scope(overrides: Partial<AgentStatusExecutionScope> = {}): AgentStatusExecutionScope {
  return {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'workspace-1',
    workspaceKind: 'git-worktree',
    ...overrides
  }
}

function alias(
  overrides: Partial<AgentStatusScopedProviderAlias> = {}
): AgentStatusScopedProviderAlias {
  return {
    ...scope(),
    provider: 'claude',
    sessionKeyKind: 'session_id',
    providerId: 'shared-provider-id',
    ...overrides
  }
}

function fullAliasIndex(entryCount: number): AgentStatusRunAliasIndex {
  return new Map(
    Array.from({ length: entryCount }, (_, entryIndex) => [
      serializeAgentStatusProviderAliasKey(alias({ providerId: `provider-${entryIndex}` })),
      new Set(Array.from({ length: 256 }, (_, runIndex) => `run-${entryIndex}-${runIndex}`))
    ])
  )
}

describe('agent status provider alias index', () => {
  it('keeps the execution-scope, provider, and session-key-kind collision matrix distinct', () => {
    const scopes = [
      scope(),
      scope({ wslDistro: 'Ubuntu' }),
      scope({ executionHostId: 'ssh:target-a' }),
      scope({ executionHostId: 'runtime:peer-a' }),
      scope({ workspaceId: 'folder-1', workspaceKind: 'folder' })
    ]
    const providers = ['claude', 'codex'] as const
    const sessionKeyKinds = ['session_id', 'conversation_id'] as const
    const aliases = scopes.flatMap((executionScope) =>
      providers.flatMap((provider) =>
        sessionKeyKinds.map((sessionKeyKind) =>
          alias({ ...executionScope, provider, sessionKeyKind })
        )
      )
    )

    expect(new Set(aliases.map(serializeAgentStatusProviderAliasKey))).toHaveLength(aliases.length)
  })

  it('serializes deterministically regardless of insertion order', () => {
    const firstKey = serializeAgentStatusProviderAliasKey(alias({ providerId: 'provider-a' }))
    const secondKey = serializeAgentStatusProviderAliasKey(alias({ providerId: 'provider-b' }))
    const first: AgentStatusRunAliasIndex = new Map([
      [secondKey, new Set(['run-b', 'run-a'])],
      [firstKey, new Set(['run-c'])]
    ])
    const second: AgentStatusRunAliasIndex = new Map([
      [firstKey, new Set(['run-c'])],
      [secondKey, new Set(['run-a', 'run-b'])]
    ])

    expect(serializeAgentStatusRunAliasIndex(first)).toBe(serializeAgentStatusRunAliasIndex(second))
  })

  it('rejects split semantic duplicates instead of storing two raw keys', () => {
    const canonical = serializeAgentStatusProviderAliasKey(alias())
    const noncanonical = canonical.replace(':[', ':[ ')
    const serialized = JSON.stringify([
      { alias: canonical, runIds: ['run-a'] },
      { alias: noncanonical, runIds: ['run-b'] }
    ])

    expect(deserializeAgentStatusRunAliasIndex(serialized)).toBeNull()
  })

  it('rejects execution-host aliases that decode to the same canonical host', () => {
    const canonical = serializeAgentStatusProviderAliasKey(
      alias({ executionHostId: 'ssh:target-a' })
    )
    const noncanonical = canonical.replace('ssh:target-a', 'ssh:%74arget-a')
    const serialized = JSON.stringify([
      { alias: canonical, runIds: ['run-a'] },
      { alias: noncanonical, runIds: ['run-b'] }
    ])

    expect(deserializeAgentStatusRunAliasIndex(serialized)).toBeNull()
  })

  it('rejects an aggregate run-reference count beyond the global limit', () => {
    const index = fullAliasIndex(65)
    const serialized = JSON.stringify(
      [...index].map(([aliasKey, runIds]) => ({ alias: aliasKey, runIds: [...runIds] }))
    )

    expect(() => serializeAgentStatusRunAliasIndex(index)).toThrow(
      'Agent status alias index exceeds its run-reference limit'
    )
    expect(deserializeAgentStatusRunAliasIndex(serialized)).toBeNull()
  })

  it('rejects an oversized serialized payload before decoding its structure', () => {
    const parse = vi.spyOn(JSON, 'parse')

    expect(deserializeAgentStatusRunAliasIndex(`${' '.repeat(4 * 1024 * 1024 + 1)}[]`)).toBeNull()
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('rejects excessive JSON structure before allocating the decoded graph', () => {
    const serialized = JSON.stringify(Array.from({ length: 22_000 }, () => ({})))
    const parse = vi.spyOn(JSON, 'parse')

    expect(deserializeAgentStatusRunAliasIndex(serialized)).toBeNull()
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })
})
