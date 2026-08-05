import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { resolveAiVaultCursorCommand } from './ai-vault-cursor-command'

function state(
  overrides: Partial<
    Pick<
      AppState,
      | 'detectedAgentCommands'
      | 'detectedAgentCommandsByContext'
      | 'remoteDetectedAgentCommands'
      | 'runtimeDetectedAgentCommands'
    >
  > = {}
): Parameters<typeof resolveAiVaultCursorCommand>[0]['state'] {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    folderWorkspaces: [],
    projectGroups: [],
    projects: [],
    repos: [],
    settings: {} as AppState['settings'],
    worktreesByRepo: {},
    ...overrides
  } as Parameters<typeof resolveAiVaultCursorCommand>[0]['state']
}

describe('resolveAiVaultCursorCommand', () => {
  it('uses isolated native and WSL inventory matches', () => {
    const source = state({
      detectedAgentCommandsByContext: {
        host: { cursor: 'cursor-agent' },
        'wsl:Ubuntu': { cursor: 'cursor agent' }
      }
    })
    expect(resolveAiVaultCursorCommand({ state: source })).toBe('cursor-agent')
    expect(
      resolveAiVaultCursorCommand({
        state: source,
        workspacePath: '\\\\wsl.localhost\\Ubuntu\\home\\ada\\repo'
      })
    ).toBe('cursor agent')
  })

  it('uses only the exact SSH or runtime host inventory', () => {
    const source = state({
      remoteDetectedAgentCommands: {
        dev: { cursor: 'cursor agent' },
        other: { cursor: 'cursor-agent' }
      },
      runtimeDetectedAgentCommands: {
        'env-1': { cursor: 'cursor-agent' }
      }
    })
    expect(
      resolveAiVaultCursorCommand({
        state: source,
        executionHostId: 'ssh:dev'
      })
    ).toBe('cursor agent')
    expect(
      resolveAiVaultCursorCommand({
        state: source,
        executionHostId: 'runtime:env-1'
      })
    ).toBe('cursor-agent')
    expect(
      resolveAiVaultCursorCommand({
        state: source,
        executionHostId: 'runtime:env-2'
      })
    ).toBeNull()
  })

  it('falls back to the flat command map only when no context-indexed map exists', () => {
    expect(
      resolveAiVaultCursorCommand({
        state: state({ detectedAgentCommands: { cursor: 'cursor-agent' } })
      })
    ).toBe('cursor-agent')
    expect(
      resolveAiVaultCursorCommand({
        state: state({
          detectedAgentCommands: { cursor: 'cursor-agent' },
          detectedAgentCommandsByContext: { 'wsl:Ubuntu': { cursor: 'cursor agent' } }
        })
      })
    ).toBeNull()
  })

  it('prefers an explicit override over every detected match', () => {
    expect(
      resolveAiVaultCursorCommand({
        state: state({
          detectedAgentCommandsByContext: { host: { cursor: 'cursor-agent' } }
        }),
        commandOverride: 'cursor-dev'
      })
    ).toBe('cursor-dev')
  })
})
