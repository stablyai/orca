import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runP4, resolveDeletableInWorkspace } = vi.hoisted(() => ({
  runP4: vi.fn(),
  resolveDeletableInWorkspace: vi.fn()
}))
vi.mock('./p4-command', () => ({ runP4, runP4OrThrow: vi.fn() }))
vi.mock('./perforce-workspace-real-path', () => ({ resolveDeletableInWorkspace }))

import { deleteChangelistWithFiles } from './perforce-changelists'

const ADDED = '... clientFile /ws/linked/new.cs\n... action add\n'

describe('deleteChangelistWithFiles', () => {
  beforeEach(() => {
    runP4.mockReset()
    resolveDeletableInWorkspace.mockReset()
  })

  it('keeps the shelf when an added file leads outside the workspace', async () => {
    runP4.mockResolvedValue({ code: 0, stdout: ADDED, stderr: '' })
    resolveDeletableInWorkspace.mockRejectedValue(new Error('Perforce file path escapes'))
    await expect(deleteChangelistWithFiles('/ws', 7)).rejects.toThrow('escapes')
    expect(runP4.mock.calls.map(([args]) => args[0])).toEqual(['-ztag'])
  })

  it('changes nothing when the opened files cannot be listed', async () => {
    runP4.mockResolvedValue({ code: 1, stdout: '', stderr: 'Perforce password (P4PASSWD) invalid' })
    const result = await deleteChangelistWithFiles('/ws', 7)
    expect(result.success).toBe(false)
    expect(runP4.mock.calls.map(([args]) => args[0])).toEqual(['-ztag'])
  })
})
