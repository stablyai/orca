// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RuntimeFileOperationArgs,
  RuntimeReadableFileContent
} from '@/runtime/runtime-file-client'

const { readFile } = vi.hoisted(() => ({ readFile: vi.fn() }))
vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: readFile,
  isMissingRuntimePathError: (error: unknown) =>
    error instanceof Error && error.message === 'ENOENT'
}))
import { useSourceControlFileGroupConfig } from './use-file-group-config'

const yaml = `sourceControl:
  fileGroups:
    - name: Snapshots
      patterns: ['**/*.snap']
`
const context: RuntimeFileOperationArgs = {
  settings: { activeRuntimeEnvironmentId: null },
  worktreeId: 'repo::/repo',
  worktreePath: '/repo'
}

beforeEach(() => {
  readFile.mockReset()
})
afterEach(cleanup)

describe('source control file-group loading', () => {
  it('reads the active worktree using its owner settings and reloads when the menu opens', async () => {
    readFile.mockResolvedValue({ content: yaml, isBinary: false })
    const remote = { ...context, settings: { activeRuntimeEnvironmentId: 'server-1' } }
    const { result } = renderHook(() => useSourceControlFileGroupConfig(remote))
    await waitFor(() => expect(result.current.fileGroups).toHaveLength(1))
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: { activeRuntimeEnvironmentId: 'server-1' },
        worktreeId: context.worktreeId,
        filePath: '/repo/orca.yaml',
        relativePath: 'orca.yaml'
      })
    )
    readFile.mockResolvedValue({ content: '', isBinary: false })
    act(() => result.current.refreshFileGroups())
    await waitFor(() => expect(result.current.fileGroups).toEqual([]))
  })

  it('pins external SSH reads and joins Windows checkout paths correctly', async () => {
    readFile.mockResolvedValue({ content: yaml, isBinary: false })
    const { result } = renderHook(() =>
      useSourceControlFileGroupConfig({
        ...context,
        worktreePath: 'C:\\repo',
        connectionId: 'ssh-1'
      })
    )
    await waitFor(() => expect(result.current.fileGroups).toHaveLength(1))
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: 'C:\\repo\\orca.yaml',
        connectionId: 'ssh-1',
        expectedExternalSshTargetId: 'ssh-1'
      })
    )
  })

  it('ignores late replies from a previous workspace or owner', async () => {
    const first = Promise.withResolvers<RuntimeReadableFileContent>()
    readFile.mockReturnValueOnce(first.promise).mockResolvedValue({ content: '', isBinary: false })
    const { result, rerender } = renderHook(useSourceControlFileGroupConfig, {
      initialProps: context
    })
    rerender({ ...context, settings: { activeRuntimeEnvironmentId: 'server-2' } })
    await waitFor(() => expect(readFile).toHaveBeenCalledTimes(2))
    await act(async () => first.resolve({ content: yaml, isBinary: false }))
    expect(result.current.fileGroups).toEqual([])
  })

  it('treats a missing file as no presets but exposes other read failures', async () => {
    readFile.mockImplementation(async () => {
      throw new Error('ENOENT')
    })
    const { result } = renderHook(() => useSourceControlFileGroupConfig(context))
    await waitFor(() => expect(readFile).toHaveBeenCalledOnce())
    expect(result.current.fileGroupsFailed).toBe(false)
    readFile.mockImplementation(async () => {
      throw new Error('Disconnected')
    })
    await act(async () => result.current.refreshFileGroups())
    await waitFor(() => expect(result.current.fileGroupsFailed).toBe(true))
    expect(result.current.fileGroups).toEqual([])
  })

  it('does not read a non-git folder workspace or absent checkout', () => {
    renderHook(() => useSourceControlFileGroupConfig({ ...context, worktreePath: null }))
    expect(readFile).not.toHaveBeenCalled()
  })
})
