// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import type { NativeChatSkillDiscoveryContext } from './native-chat-skill-discovery-context'
import { renderHook } from '@testing-library/react'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: object) => unknown) => selector({})
}))
vi.mock('zustand/react/shallow', () => ({ useShallow: <T>(selector: T) => selector }))
vi.mock('./native-chat-skill-discovery-context', () => ({
  selectNativeChatSkillStateInputs: () => ({}),
  resolveNativeChatSkillDiscoveryContext: () => null
}))

import { canUseLocalOmpRpcProbe, useNativeChatComposerCommands } from './use-omp-rpc-commands'

function context(
  executionHostKind: NativeChatSkillDiscoveryContext['executionHostKind'],
  projectRuntime?: NativeChatSkillDiscoveryContext['discoveryTarget']['projectRuntime']
): NativeChatSkillDiscoveryContext {
  return {
    key: 'key',
    cwd: '/work/project',
    executionHostKind,
    runtimeTarget: { kind: 'local' },
    discoveryTarget: { cwd: '/work/project', ...(projectRuntime ? { projectRuntime } : {}) }
  }
}

describe('canUseLocalOmpRpcProbe', () => {
  it.each(['ssh', 'runtime'] as const)(
    'refuses the client-local probe for a %s-owned pane',
    (executionHostKind) => {
      expect(canUseLocalOmpRpcProbe(context(executionHostKind))).toBe(false)
    }
  )

  it('refuses the Windows client-local probe for a WSL pane', () => {
    expect(
      canUseLocalOmpRpcProbe(
        context('local', {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project-1',
            distro: 'Ubuntu',
            reason: 'project-override',
            cacheKey: 'wsl:Ubuntu'
          }
        })
      )
    ).toBe(false)
  })

  it('admits a native local pane', () => {
    expect(canUseLocalOmpRpcProbe(context('local'))).toBe(true)
  })
})

describe('useNativeChatComposerCommands', () => {
  it('uses the structured command catalog for the selected agent', () => {
    const { result } = renderHook(() =>
      useNativeChatComposerCommands({ agent: 'claude', terminalTabId: 'tab-1', structured: true })
    )

    expect(result.current.agentCommands.map((command) => command.name)).toContain('compact')
    expect(result.current.agentCommands.map((command) => command.name)).not.toContain('vim')
  })
})
