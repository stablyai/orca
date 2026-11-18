// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const resolveWslMappedDrivePath = vi.hoisted(() =>
  vi.fn(async (_path: string): Promise<string | null> => '\\\\wsl.localhost\\Ubuntu')
)
vi.mock('../sidebar/project-admission/host-selection/wsl-mapped-drive-path', () => ({
  resolveWslMappedDrivePath
}))

import {
  refreshWslMappedDriveShare,
  resetWslMappedDriveShareStoreForTests,
  useWslMappedDriveShare
} from './wsl-mapped-drive-share-store'

afterEach(() => {
  cleanup()
  resetWslMappedDriveShareStoreForTests()
  resolveWslMappedDrivePath.mockClear()
})

describe('useWslMappedDriveShare', () => {
  it('shows a known answer at once when a menu opens again, without asking main', async () => {
    const first = renderHook(() => useWslMappedDriveShare('W:\\home\\me\\app'))
    await waitFor(() => expect(first.result.current).toBe('\\\\wsl.localhost\\Ubuntu'))
    first.unmount()
    const again = renderHook(() => useWslMappedDriveShare('W:\\home\\me\\app'))
    expect(again.result.current).toBe('\\\\wsl.localhost\\Ubuntu')
    expect(resolveWslMappedDrivePath).toHaveBeenCalledTimes(1)
  })

  it('refreshes a stale answer outside render and updates every reader', async () => {
    const view = renderHook(() => useWslMappedDriveShare('W:\\x'))
    await waitFor(() => expect(view.result.current).toBe('\\\\wsl.localhost\\Ubuntu'))
    resolveWslMappedDrivePath.mockResolvedValueOnce(null)
    await act(async () => refreshWslMappedDriveShare('W', Number.MAX_SAFE_INTEGER))
    await waitFor(() => expect(view.result.current).toBeNull())
    expect(resolveWslMappedDrivePath).toHaveBeenCalledTimes(2)
  })
})
