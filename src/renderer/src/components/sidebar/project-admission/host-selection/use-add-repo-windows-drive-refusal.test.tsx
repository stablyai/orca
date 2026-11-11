// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

const client = vi.hoisted(() => ({ windowsDesktop: true }))
vi.mock('@/lib/files/os-open/windows-path-access', () => ({
  isWindowsDesktopClient: () => client.windowsDesktop
}))

import { useAddRepoWindowsDriveRefusal } from './use-add-repo-windows-drive-refusal'

const WSL_HOST: ExecutionHostId = 'runtime:wsl%3AUbuntu'
const REFUSAL = { kind: 'wsl_host_windows_drive_path', windowsPath: 'C:\\src\\app' } as const

function setup(selectable = true) {
  const selectHost = vi.fn(async () => selectable)
  const addLocalPath = vi.fn(async () => {})
  const createStep = { setStep: vi.fn(), setCreateParent: vi.fn() }
  const view = renderHook(
    ({ selectedHostId }: { selectedHostId: ExecutionHostId }) =>
      useAddRepoWindowsDriveRefusal({
        isOpen: true,
        selectedHostId,
        selectHost,
        addLocalPath,
        createStep
      }),
    { initialProps: { selectedHostId: WSL_HOST } }
  )
  const clickAddOnThisComputer = () => {
    const { unmount } = render(<>{view.result.current.notice}</>)
    fireEvent.click(screen.getByRole('button', { name: 'Add on this computer' }))
    unmount()
  }
  return { view, selectHost, addLocalPath, createStep, clickAddOnThisComputer }
}

describe('useAddRepoWindowsDriveRefusal', () => {
  afterEach(() => {
    cleanup()
    client.windowsDesktop = true
  })

  it('drops the add when this computer could not be selected, so a later switch adds nothing', async () => {
    const { view, addLocalPath, clickAddOnThisComputer } = setup(false)
    act(() => view.result.current.showRefusal(REFUSAL))
    clickAddOnThisComputer()
    await act(async () => {})
    view.rerender({ selectedHostId: 'local' })
    expect(addLocalPath).not.toHaveBeenCalled()
  })
})
