import { describe, expect, it, vi } from 'vitest'

vi.mock('./web-runtime-terminal-create-operation', () => ({
  createWebRuntimeSessionTerminalResult: vi.fn(async () => ({
    outcome: { status: 'created' },
    hostTabId: 'T::L'
  }))
}))
vi.mock('../../../store/index', () => ({
  useAppStore: { getState: () => ({}) }
}))

import { createWebRuntimeSessionTerminalOnHost } from './web-runtime-terminal-creation'
import { webTerminalMirroredTabId } from '../placement/web-session-terminal-placement'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'

describe('created paired-host terminal tab id', () => {
  it('maps a host surface id to the tab id this client mirrors it under', () => {
    expect(webTerminalMirroredTabId('T::L')).toBe(toWebTerminalSurfaceTabId('T'))
    expect(webTerminalMirroredTabId('T')).toBe(toWebTerminalSurfaceTabId('T'))
  })

  it('reports the mirrored id on a created outcome', async () => {
    await expect(
      createWebRuntimeSessionTerminalOnHost({
        worktreeId: 'wt-1',
        environmentId: 'env-1'
      })
    ).resolves.toEqual({
      status: 'created',
      mirroredTabId: toWebTerminalSurfaceTabId('T')
    })
  })
})
