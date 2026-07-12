// @vitest-environment happy-dom

import type React from 'react'
import type * as ReactModule from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WslSourcePicker } from './WslSourcePicker'

const getDistroOptions = vi.fn()
const pickDirectory = vi.fn()
const toastError = vi.fn()

vi.mock('sonner', () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) }
}))

// Why: DialogTitle/DialogHeader/DialogDescription require a real Dialog root
// context; the picker is normally mounted inside AddRepoDialogChrome's Dialog,
// so unit tests stub them the same way AddRepoStartSteps.test.tsx does.
vi.mock('@/components/ui/dialog', () => ({
  DialogDescription: ({ children }: { children: ReactModule.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactModule.ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactModule.ReactNode }) => <h1>{children}</h1>
}))

beforeEach(() => {
  getDistroOptions.mockReset()
  pickDirectory.mockReset()
  toastError.mockReset()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only window.api shim
  ;(window as any).api = {
    wsl: { getDistroOptions },
    shell: { pickDirectory }
  }
})

afterEach(() => {
  document.body.replaceChildren()
})

function renderPicker(overrides: Partial<React.ComponentProps<typeof WslSourcePicker>> = {}) {
  const onDistroChange = vi.fn()
  const onPathChange = vi.fn()
  const onAddWsl = vi.fn()
  const utils = render(
    <TooltipProvider>
      <WslSourcePicker
        wslDistro=""
        wslPath=""
        wslError={null}
        isAddingWsl={false}
        addProjectBusyLabel={null}
        onDistroChange={onDistroChange}
        onPathChange={onPathChange}
        onAddWsl={onAddWsl}
        {...overrides}
      />
    </TooltipProvider>
  )
  return { ...utils, onDistroChange, onPathChange, onAddWsl }
}

describe('WslSourcePicker', () => {
  it('preselects the default distro once options resolve', async () => {
    getDistroOptions.mockResolvedValue({
      available: true,
      distros: ['Ubuntu-24.04', 'Debian'],
      default: 'Ubuntu-24.04'
    })
    const { onDistroChange } = renderPicker()
    await act(async () => {})

    expect(getDistroOptions).toHaveBeenCalledWith({ refresh: false })
    expect(onDistroChange).toHaveBeenCalledWith('Ubuntu-24.04')
  })

  it('shows the unavailable message and disables the distro control when WSL is not installed', async () => {
    getDistroOptions.mockResolvedValue({ available: false, distros: [], default: null })
    const { getByText, container } = renderPicker()
    await act(async () => {})

    expect(getByText('WSL is not available on this computer.')).toBeTruthy()
    const trigger = container.querySelector('#wsl-distro') as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
  })

  it('shows the empty-distros message when WSL is available with no distros installed', async () => {
    getDistroOptions.mockResolvedValue({ available: true, distros: [], default: null })
    const { getByText } = renderPicker()
    await act(async () => {})

    expect(getByText('No WSL distros found. Install one, then refresh.')).toBeTruthy()
  })

  it('re-queries with refresh:true when the refresh button is clicked', async () => {
    getDistroOptions.mockResolvedValue({
      available: true,
      distros: ['Ubuntu-24.04'],
      default: 'Ubuntu-24.04'
    })
    const { getByLabelText } = renderPicker()
    await act(async () => {})
    getDistroOptions.mockClear()

    await act(async () => {
      fireEvent.click(getByLabelText('Refresh distros'))
    })

    expect(getDistroOptions).toHaveBeenCalledWith({ refresh: true })
  })

  it('disables submit until both distro and path are filled in', async () => {
    getDistroOptions.mockResolvedValue({
      available: true,
      distros: ['Ubuntu-24.04'],
      default: 'Ubuntu-24.04'
    })
    const { getByText } = renderPicker({ wslDistro: '', wslPath: '' })
    await act(async () => {})

    expect((getByText('Add Git Project') as HTMLButtonElement).disabled).toBe(true)
  })

  it('calls onAddWsl("git") when Add Git Project is clicked with distro and path filled in', async () => {
    getDistroOptions.mockResolvedValue({
      available: true,
      distros: ['Ubuntu-24.04'],
      default: 'Ubuntu-24.04'
    })
    const { getByText, onAddWsl } = renderPicker({
      wslDistro: 'Ubuntu-24.04',
      wslPath: '/home/user/project'
    })
    await act(async () => {})

    fireEvent.click(getByText('Add Git Project'))

    expect(onAddWsl).toHaveBeenCalledWith('git')
  })

  it('routes browse through the selected distro share and converts the pick to a POSIX path', async () => {
    getDistroOptions.mockResolvedValue({
      available: true,
      distros: ['Ubuntu-24.04'],
      default: 'Ubuntu-24.04'
    })
    pickDirectory.mockResolvedValue('\\\\wsl.localhost\\Ubuntu-24.04\\home\\user\\project')
    const { getByLabelText, onDistroChange, onPathChange } = renderPicker({
      wslDistro: 'Ubuntu-24.04'
    })
    await act(async () => {})

    await act(async () => {
      fireEvent.click(getByLabelText('Browse WSL filesystem'))
    })

    expect(pickDirectory).toHaveBeenCalledWith({
      defaultPath: '\\\\wsl.localhost\\Ubuntu-24.04\\'
    })
    expect(onDistroChange).toHaveBeenCalledWith('Ubuntu-24.04')
    expect(onPathChange).toHaveBeenCalledWith('/home/user/project')
  })

  it('rejects a picked folder outside any WSL share', async () => {
    getDistroOptions.mockResolvedValue({
      available: true,
      distros: ['Ubuntu-24.04'],
      default: 'Ubuntu-24.04'
    })
    pickDirectory.mockResolvedValue('C:\\Users\\dev\\project')
    const { getByLabelText, onPathChange } = renderPicker({ wslDistro: 'Ubuntu-24.04' })
    await act(async () => {})

    await act(async () => {
      fireEvent.click(getByLabelText('Browse WSL filesystem'))
    })

    expect(onPathChange).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })
})
