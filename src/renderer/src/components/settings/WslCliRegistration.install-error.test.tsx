// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { WslCliRegistration } from './WslCliRegistration'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))

vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({
    gitBashAvailable: false,
    hostPlatform: 'win32',
    isLoading: false,
    pwshAvailable: false,
    wslAvailable: true,
    wslDistros: ['Ubuntu']
  })
}))

vi.mock('../ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>
}))

vi.mock('../ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const NOT_INSTALLED_WSL_STATUS: CliInstallStatus = {
  platform: 'linux',
  commandName: 'orca-ide',
  commandPath: '/home/user/.local/bin/orca-ide',
  pathDirectory: '/home/user/.local/bin',
  pathConfigured: false,
  launcherPath: '/mnt/c/Users/user/AppData/Local/Programs/Orca/resources/bin/orca',
  installMethod: 'symlink',
  supported: true,
  state: 'not_installed',
  currentTarget: null,
  unsupportedReason: null,
  detail: 'Register orca-ide in WSL.'
}

let root: Root | null = null
let container: HTMLDivElement | null = null
const getWslInstallStatus = vi.fn()
const installWsl = vi.fn()
const removeWsl = vi.fn()

async function renderSection(refreshSignal = 0): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<WslCliRegistration currentPlatform="win32" refreshSignal={refreshSignal} />)
  })
  await act(async () => {})
}

async function rerenderSection(refreshSignal: number): Promise<void> {
  await act(async () => {
    root?.render(<WslCliRegistration currentPlatform="win32" refreshSignal={refreshSignal} />)
  })
  await act(async () => {})
}

describe('WslCliRegistration persistent install error', () => {
  beforeEach(() => {
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
    getWslInstallStatus.mockReset()
    installWsl.mockReset()
    removeWsl.mockReset()
    getWslInstallStatus.mockResolvedValue(NOT_INSTALLED_WSL_STATUS)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: {
          getWslInstallStatus,
          installWsl,
          removeWsl
        }
      }
    })
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    container?.remove()
    root = null
    container = null
  })

  it('persists a failed WSL install reason in the open dialog and inline after close', async () => {
    installWsl.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'cli:installWsl': Error: Failed to create /home/user/.local/bin"
      )
    )
    await renderSection()

    const cliSwitch = container?.querySelector<HTMLButtonElement>('button[role="switch"]')
    expect(cliSwitch).toBeDefined()
    await act(async () => {
      cliSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const registerButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Register'
    )
    expect(registerButton).toBeDefined()
    await act(async () => {
      registerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    const alerts = Array.from(container?.querySelectorAll('[role="alert"]') ?? [])
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      'Failed to create /home/user/.local/bin'
    ])
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to create /home/user/.local/bin')

    const cancelButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(
      Array.from(container?.querySelectorAll('[role="alert"]') ?? []).map(
        (alert) => alert.textContent
      )
    ).toEqual(['Failed to create /home/user/.local/bin'])
  })

  it('clears a persisted WSL install error after an external successful registration', async () => {
    installWsl.mockRejectedValueOnce(new Error('Failed to create /home/user/.local/bin'))
    await renderSection()

    const cliSwitch = container?.querySelector<HTMLButtonElement>('button[role="switch"]')
    await act(async () => {
      cliSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const registerButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Register'
    )
    await act(async () => {
      registerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    const cancelButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Cancel'
    )
    await act(async () => {
      cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      'Failed to create /home/user/.local/bin'
    )

    getWslInstallStatus.mockResolvedValueOnce({
      ...NOT_INSTALLED_WSL_STATUS,
      state: 'installed',
      pathConfigured: true,
      detail: 'Registered orca-ide in WSL.'
    })
    await rerenderSection(1)

    expect(container?.querySelector('[role="alert"]')).toBeNull()
  })
})
