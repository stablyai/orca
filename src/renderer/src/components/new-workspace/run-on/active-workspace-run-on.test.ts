import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/orca-cloud/orca-cloud-environment-id', () => ({
  isOrcaCloudExecutionHostId: (hostId: string | null) => hostId === 'runtime:cloud-env'
}))

import { withActiveWorkspaceRunOn } from './active-workspace-run-on'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'

describe('withActiveWorkspaceRunOn', () => {
  it('opens on Orca Cloud from a cloud workspace', () => {
    expect(withActiveWorkspaceRunOn({}, 'runtime:cloud-env').initialEphemeralVmRecipeId).toBe(
      ORCA_CLOUD_RECIPE_ID
    )
  })

  it('leaves local and SSH workspaces to the active project', () => {
    const data = { telemetrySource: 'shortcut' as const }
    expect(withActiveWorkspaceRunOn(data, 'local')).toBe(data)
    expect(withActiveWorkspaceRunOn(data, 'ssh:box')).toBe(data)
    expect(withActiveWorkspaceRunOn(data, null)).toBe(data)
  })

  it('never overrides a target the opener chose', () => {
    for (const data of [
      { initialRepoId: 'repo' },
      { initialEphemeralVmRecipeId: 'custom' },
      { recovery: { note: '', agent: null } }
    ]) {
      expect(withActiveWorkspaceRunOn(data, 'runtime:cloud-env')).toBe(data)
    }
  })
})
