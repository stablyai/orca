// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { useAppStore } from '../../store'
import { useAgentSkillHostScope } from './use-agent-skill-host-scope'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type ScopeRuntime = Parameters<typeof useAgentSkillHostScope>[0]

function environment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: id,
    endpoints: [],
    preferredEndpointId: id
  }
}

async function scopeOf(runtime: ScopeRuntime): Promise<ReturnType<typeof useAgentSkillHostScope>> {
  let scope: ReturnType<typeof useAgentSkillHostScope> = null
  function Probe(): null {
    scope = useAgentSkillHostScope(runtime)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  await act(async () => root.unmount())
  return scope
}

describe('useAgentSkillHostScope', () => {
  afterEach(() => {
    useAppStore.setState({ runtimeEnvironments: [] })
  })

  it('names the WSL distro the bridge scans instead of this machine', async () => {
    expect(
      await scopeOf({
        agentRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' },
        bundledSkillTarget: null
      })
    ).toEqual({ hostId: 'local', label: 'WSL Ubuntu' })
  })

  it('names the paired or managed server that planned its own disk', async () => {
    useAppStore.setState({ runtimeEnvironments: [environment('env-1', 'build-box')] })

    expect(
      await scopeOf({ bundledSkillTarget: { kind: 'environment', environmentId: 'env-1' } })
    ).toEqual({ hostId: 'runtime:env-1', label: 'build-box' })
  })

  it('stays unscoped for an SSH host no server reads yet', async () => {
    expect(await scopeOf({ bundledSkillTarget: { kind: 'ssh', targetId: 'box' } })).toBeNull()
  })
})
