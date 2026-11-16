import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { GlobalWindowsRuntimeDefault } from '../../../../../shared/execution-host/project-runtime-preference'
import { resolveProjectSkillRuntime } from './project-skill-runtime-resolution'

type Input = Parameters<typeof resolveProjectSkillRuntime>[0]

function stateWithActiveWorktree(
  localWindowsRuntimeDefault?: GlobalWindowsRuntimeDefault
): Input['state'] {
  const settings = getDefaultSettings('/home/test')
  return {
    activeRepoId: 'repo-1',
    activeWorktreeId: 'repo-1::/work/app',
    projects: [],
    repos: [],
    settings: localWindowsRuntimeDefault ? { ...settings, localWindowsRuntimeDefault } : settings,
    worktreesByRepo: {}
  }
}

describe('resolveProjectSkillRuntime with a picked host', () => {
  it('checks the picked paired host, not the local workspace (#34261)', () => {
    const runtime = resolveProjectSkillRuntime({
      state: stateWithActiveWorktree(),
      activeWorkspaceHostId: 'local',
      runtimeTarget: { kind: 'local' },
      currentPlatform: 'darwin',
      wslContext: {},
      hostId: 'runtime:wsl-ubuntu'
    })

    expect(runtime.discoveryRuntimeTarget).toEqual({
      kind: 'environment',
      environmentId: 'wsl-ubuntu'
    })
    expect(runtime.discoveryTarget).toBeUndefined()
    expect(runtime.bundledSkillTarget).toEqual({
      kind: 'environment',
      environmentId: 'wsl-ubuntu'
    })
  })

  it("checks this computer's WSL default when picked while the workspace is on a paired host", () => {
    const runtime = resolveProjectSkillRuntime({
      state: stateWithActiveWorktree({ kind: 'wsl', distro: 'Ubuntu-24.04' }),
      activeWorkspaceHostId: 'runtime:paired',
      runtimeTarget: { kind: 'environment', environmentId: 'paired' },
      currentPlatform: 'win32',
      wslContext: { wslAvailable: true, availableWslDistros: ['Ubuntu-24.04'] },
      hostId: 'local'
    })

    expect(runtime.discoveryRuntimeTarget).toEqual({ kind: 'local' })
    expect(runtime.discoveryTarget?.projectRuntime).toMatchObject({
      status: 'resolved',
      runtime: { kind: 'wsl', distro: 'Ubuntu-24.04' }
    })
  })
})
