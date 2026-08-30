// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { getDefaultSettings } from '../../../../shared/constants'
import { CliSection } from './CliSection'

const mocks = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastWarning: vi.fn(),
  ensurePrerequisite: vi.fn(),
  dialog: { onInstall: null as null | (() => Promise<void>) },
  panel: { onBeforeOpenTerminal: null as null | (() => Promise<void>) }
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    message: mocks.toastMessage,
    success: mocks.toastSuccess,
    warning: mocks.toastWarning
  }
}))

vi.mock('@/lib/agent-skill-cli-prerequisite', () => ({
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE:
    'Before opening setup, Orca may show a system prompt to register the Orca CLI command on PATH.',
  ensureOrcaCliAvailableForAgentSkillTerminal: mocks.ensurePrerequisite,
  isOrcaCliAvailableOnPath: (status: CliInstallStatus | null | undefined) =>
    status?.state === 'installed' && status.pathConfigured
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['global'],
  useInstalledAgentSkill: () => ({
    installed: false,
    loading: false,
    error: null,
    refresh: vi.fn()
  })
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: { onBeforeOpenTerminal: () => Promise<void> }) => {
    mocks.panel.onBeforeOpenTerminal = props.onBeforeOpenTerminal
    return <div data-testid="agent-skill-setup-panel" />
  }
}))

// Capture the dialog's install callback so the test can trigger the install
// flow without driving the Radix dialog portal.
vi.mock('./CliRegistrationDialog', () => ({
  CliRegistrationDialog: (props: {
    actionError: string | null
    onInstall: () => Promise<void>
    open: boolean
  }) => {
    mocks.dialog.onInstall = props.onInstall
    return props.open && props.actionError ? (
      <p data-testid="registration-dialog-error" role="alert">
        {props.actionError}
      </p>
    ) : null
  }
}))

vi.mock('./WslCliRegistration', () => ({
  WslCliRegistration: () => null
}))

const NOT_INSTALLED_STATUS: CliInstallStatus = {
  platform: 'darwin',
  commandName: 'orca',
  commandPath: '/usr/local/bin/orca',
  pathDirectory: '/usr/local/bin',
  pathConfigured: false,
  launcherPath: '/Applications/Orca.app/Contents/Resources/bin/orca',
  installMethod: 'symlink',
  supported: true,
  state: 'not_installed',
  currentTarget: null,
  unsupportedReason: null,
  detail: 'Register /usr/local/bin/orca to use Orca from the terminal.'
}

let root: Root | null = null
let container: HTMLDivElement | null = null
const getInstallStatus = vi.fn()
const install = vi.fn()

async function renderSection(): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<CliSection currentPlatform="darwin" settings={getDefaultSettings('/tmp')} />)
  })
  await act(async () => {})
}

describe('CliSection persistent install error', () => {
  beforeEach(() => {
    mocks.toastError.mockReset()
    mocks.toastMessage.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.toastWarning.mockReset()
    mocks.ensurePrerequisite.mockReset()
    mocks.dialog.onInstall = null
    mocks.panel.onBeforeOpenTerminal = null
    getInstallStatus.mockReset()
    install.mockReset()
    getInstallStatus.mockResolvedValue(NOT_INSTALLED_STATUS)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: { getInstallStatus, install, remove: vi.fn() },
        shell: { openPath: vi.fn() }
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

  it('persists a failed install reason inline and clears it on a successful refresh', async () => {
    install.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'cli:install': Error: Directory /usr/local/bin does not exist on this system"
      )
    )
    await renderSection()

    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})

    const alert = container?.querySelector('[role="alert"]')
    expect(alert?.textContent).toBe('Directory /usr/local/bin does not exist on this system')
    expect(alert?.className).toContain('text-destructive')
    expect(mocks.toastError).toHaveBeenCalledWith(
      'Directory /usr/local/bin does not exist on this system'
    )

    // Refreshing status clears the stale failure so it does not linger forever.
    const refreshButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.getAttribute('aria-label') === 'Refresh CLI status'
    )
    expect(refreshButton).toBeDefined()
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(container?.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps a persisted install error when refreshing status fails', async () => {
    install.mockRejectedValueOnce(new Error('Failed to create /usr/local/bin'))
    await renderSection()

    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      'Failed to create /usr/local/bin'
    )

    getInstallStatus.mockRejectedValueOnce(new Error('Failed to load CLI status.'))
    const refreshButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.getAttribute('aria-label') === 'Refresh CLI status'
    )
    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {})

    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      'Failed to create /usr/local/bin'
    )
  })

  it('clears a persisted install error after a later install succeeds', async () => {
    install
      .mockRejectedValueOnce(new Error('Failed to create /usr/local/bin'))
      .mockResolvedValueOnce({
        ...NOT_INSTALLED_STATUS,
        state: 'installed',
        pathConfigured: true,
        detail: 'Registered /usr/local/bin/orca.'
      })
    await renderSection()

    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      'Failed to create /usr/local/bin'
    )

    // A subsequent successful install must clear the stale failure, so the user
    // can tell "install failed" apart from "now installed".
    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})

    expect(container?.querySelector('[role="alert"]')).toBeNull()
    expect(mocks.toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('keeps a failed install reason visible while the registration dialog stays open', async () => {
    install.mockRejectedValueOnce(new Error('Failed to create /usr/local/bin'))
    await renderSection()

    const cliSwitch = container?.querySelector<HTMLButtonElement>('button[role="switch"]')
    expect(cliSwitch).toBeDefined()
    await act(async () => {
      cliSwitch?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})

    expect(container?.querySelector('[data-testid="registration-dialog-error"]')?.textContent).toBe(
      'Failed to create /usr/local/bin'
    )
  })

  it('clears a persisted install error when agent skill setup registers the CLI', async () => {
    install.mockRejectedValueOnce(new Error('Failed to create /usr/local/bin'))
    mocks.ensurePrerequisite.mockImplementationOnce(
      async ({ onStatusChange }: { onStatusChange?: (status: CliInstallStatus) => void }) => {
        onStatusChange?.({
          ...NOT_INSTALLED_STATUS,
          state: 'installed',
          pathConfigured: true,
          detail: 'Registered /usr/local/bin/orca.'
        })
      }
    )
    await renderSection()

    await act(async () => {
      await mocks.dialog.onInstall?.()
    })
    await act(async () => {})
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      'Failed to create /usr/local/bin'
    )

    await act(async () => {
      await mocks.panel.onBeforeOpenTerminal?.()
    })
    await act(async () => {})

    expect(container?.querySelector('[role="alert"]')).toBeNull()
  })
})
