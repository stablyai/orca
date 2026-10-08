import { afterEach, describe, expect, it, vi } from 'vitest'
import { refreshPerforceOpenedFiles } from './perforce-opened-files'
import type { PerforceWorkspaceTarget } from '../../../runtime/runtime-perforce-client'

const local = (worktreePath: string): PerforceWorkspaceTarget => ({
  settings: { activeRuntimeEnvironmentId: null },
  worktreeId: null,
  worktreePath
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('refreshPerforceOpenedFiles', () => {
  it('runs one status per workspace at a time, and once more for anything asked meanwhile', async () => {
    const answers: (() => void)[] = []
    const run = vi.fn(() => new Promise((resolve) => answers.push(() => resolve({ entries: [] }))))
    vi.stubGlobal('window', { api: { perforce: { run } } })

    // Three tabs of one workspace ask together, as on a session restore.
    const asked = [
      refreshPerforceOpenedFiles(local('/ws')),
      refreshPerforceOpenedFiles(local('/ws')),
      refreshPerforceOpenedFiles(local('/ws'))
    ]
    const other = refreshPerforceOpenedFiles(local('/other'))
    expect(run).toHaveBeenCalledTimes(2)

    answers.shift()?.()
    // The asks that arrived while the first ran share one more run, so a save is never missed.
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(3))
    answers.splice(0).forEach((answer) => answer())
    await Promise.all([...asked, other])
    expect(run).toHaveBeenCalledTimes(3)
  })
})
