import { afterEach, describe, expect, it, vi } from 'vitest'

const request = {
  repoId: 'repo-1',
  name: 'feature',
  setupDecision: 'inherit',
  creationId: 'creation-1'
} as const

async function runtimeParams(switchedOn: boolean): Promise<Record<string, unknown>> {
  vi.resetModules()
  vi.doMock('../../../../../../shared/sidebar-inputs-switch', () => ({
    ORCA_SIDEBAR_INPUTS_IS_MAIN: switchedOn
  }))
  const { buildRuntimeWorktreeCreateParams } = await import('./worktree-create-payload')
  return buildRuntimeWorktreeCreateParams(request, { name: request.name })
}

describe('the creation id sent to a paired server', () => {
  afterEach(() => {
    vi.doUnmock('../../../../../../shared/sidebar-inputs-switch')
  })

  it('rides the request only when main produces the sidebar inputs', async () => {
    expect(await runtimeParams(true)).toMatchObject({ creationId: 'creation-1' })
    expect(await runtimeParams(false)).not.toHaveProperty('creationId')
  })
})
