// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const client = vi.hoisted(() => ({ windowsDesktop: true }))
vi.mock('@/lib/windows-path-access', () => ({
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

  it('shows the refusal inline and adds the folder on this computer once the switch lands', () => {
    const { view, selectHost, addLocalPath, clickAddOnThisComputer } = setup()
    expect(view.result.current.notice).toBeNull()
    act(() => view.result.current.showRefusal(REFUSAL))
    expect(view.result.current.notice).not.toBeNull()

    clickAddOnThisComputer()
    expect(selectHost).toHaveBeenCalledWith('local')
    // Nothing is added while the dialog is still on the WSL host.
    expect(addLocalPath).not.toHaveBeenCalled()

    view.rerender({ selectedHostId: 'local' })
    expect(addLocalPath).toHaveBeenCalledTimes(1)
    expect(addLocalPath).toHaveBeenCalledWith('C:\\src\\app', 'local_folder_picker')
    // The notice belonged to the WSL host.
    expect(view.result.current.notice).toBeNull()
  })

  it('drops the add when this computer could not be selected, so a later switch adds nothing', async () => {
    const { view, addLocalPath, clickAddOnThisComputer } = setup(false)
    act(() => view.result.current.showRefusal(REFUSAL))
    clickAddOnThisComputer()
    await act(async () => {})
    view.rerender({ selectedHostId: 'local' })
    expect(addLocalPath).not.toHaveBeenCalled()
  })

  it('reopens a refused create on this computer with the parent folder filled in', () => {
    const { view, addLocalPath, createStep, clickAddOnThisComputer } = setup()
    act(() => view.result.current.showRefusal(REFUSAL, 'create'))
    clickAddOnThisComputer()
    view.rerender({ selectedHostId: 'local' })
    expect(createStep.setStep).toHaveBeenCalledWith('create')
    expect(createStep.setCreateParent).toHaveBeenCalledWith('C:\\src\\app')
    expect(addLocalPath).not.toHaveBeenCalled()
  })

  it.each([
    ['the host could not name the drive path', { ...REFUSAL, windowsPath: null }, true],
    ['this client is not a Windows desktop', REFUSAL, false]
  ])('offers no switch when %s', (_case, refusal, windowsDesktop) => {
    client.windowsDesktop = windowsDesktop
    const { view } = setup()
    act(() => view.result.current.showRefusal(refusal))
    render(<>{view.result.current.notice}</>)
    expect(screen.queryByRole('button', { name: 'Add on this computer' })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('on a Windows drive')
  })
})
