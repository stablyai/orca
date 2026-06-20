// @vitest-environment happy-dom

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toast } from 'sonner'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LinearAgentSkillSetupPrompt,
  _linearAgentSkillSetupPromptInternalsForTests
} from './LinearAgentSkillSetupPrompt'

const HOST_DISMISS_STORAGE_KEY = 'orca.linearTicketsSkill.setupDismissed.host'

const mocks = vi.hoisted(() => ({
  skillState: {
    installed: false,
    loading: false,
    error: null as string | null,
    refresh: vi.fn(async () => {})
  },
  useInstalledAgentSkill: vi.fn(),
  getCliStatus: vi.fn(),
  getWslCliStatus: vi.fn(),
  ensureCli: vi.fn(async () => null as CliInstallStatus | null),
  ensureWslCli: vi.fn(async () => null as CliInstallStatus | null),
  toastDismiss: vi.fn(),
  toastWarning: vi.fn(() => 'linear-setup-toast-id'),
  panelProps: [] as Record<string, unknown>[]
}))

vi.mock('sonner', () => ({
  toast: {
    dismiss: mocks.toastDismiss,
    warning: mocks.toastWarning
  }
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkill: mocks.useInstalledAgentSkill
}))

vi.mock('@/lib/agent-skill-cli-prerequisite', () => ({
  AGENT_SKILL_CLI_PREREQUISITE_NOTICE: 'CLI registration notice',
  ensureOrcaCliAvailableForAgentSkillTerminal: mocks.ensureCli,
  isOrcaCliAvailableOnPath: (status: CliInstallStatus | null | undefined) =>
    status?.state === 'installed' && status.pathConfigured
}))

vi.mock('../settings/CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: (
    command: string,
    runtime: { runtime: string; wslDistro?: string | null }
  ) =>
    runtime.runtime === 'wsl'
      ? `wsl.exe${runtime.wslDistro ? ` -d '${runtime.wslDistro}'` : ''} -- bash -lc '${command}'`
      : command,
  ensureWslCliAvailableForAgentSkillTerminal: mocks.ensureWslCli,
  getWslCliDistroRequest: (runtime?: { runtime: string; wslDistro?: string | null }) =>
    runtime?.runtime === 'wsl' && runtime.wslDistro?.trim()
      ? { distro: runtime.wslDistro.trim() }
      : undefined
}))

vi.mock('../settings/AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: Record<string, unknown> & { children?: ReactNode }) => {
    mocks.panelProps.push(props)
    return (
      <section data-testid="linear-skill-inline-panel">
        <h2>{String(props.title)}</h2>
        <p>{String(props.description)}</p>
        <code>{String(props.command)}</code>
        <button type="button" onClick={() => void (props.onBeforeOpenTerminal as () => void)()}>
          Mock install
        </button>
        <button type="button" onClick={() => void (props.onRecheck as () => void)()}>
          Re-check
        </button>
      </section>
    )
  }
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function cliStatus(overrides: Partial<CliInstallStatus>): CliInstallStatus {
  return {
    platform: 'darwin',
    commandName: 'orca',
    commandPath: '/usr/local/bin/orca',
    pathDirectory: '/usr/local/bin',
    pathConfigured: true,
    launcherPath: '/Applications/Orca.app/Contents/MacOS/Orca',
    installMethod: 'symlink',
    supported: true,
    state: 'installed',
    currentTarget: '/Applications/Orca.app/Contents/MacOS/Orca',
    unsupportedReason: null,
    detail: null,
    ...overrides
  }
}

async function renderPrompt(
  props: ComponentProps<typeof LinearAgentSkillSetupPrompt>
): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<LinearAgentSkillSetupPrompt {...props} />)
  })
  await act(async () => {})
}

async function unmountPrompt(): Promise<void> {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
}

function findBodyButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === label
  )
}

async function snoozeInitialModal(
  props: ComponentProps<typeof LinearAgentSkillSetupPrompt>
): Promise<void> {
  await renderPrompt(props)
  await act(async () => {
    findBodyButton('Not now')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await unmountPrompt()
}

type ReminderToastAction = {
  label?: string
  onClick?: () => void
}

describe('LinearAgentSkillSetupPrompt reminder toast', () => {
  beforeEach(() => {
    mocks.skillState.installed = false
    mocks.skillState.loading = false
    mocks.skillState.error = null
    mocks.skillState.refresh.mockReset()
    mocks.skillState.refresh.mockImplementation(async () => {})
    mocks.useInstalledAgentSkill.mockReset()
    mocks.useInstalledAgentSkill.mockReturnValue(mocks.skillState)
    mocks.getCliStatus.mockReset()
    mocks.getCliStatus.mockResolvedValue(
      cliStatus({ state: 'not_installed', pathConfigured: false })
    )
    mocks.getWslCliStatus.mockReset()
    mocks.getWslCliStatus.mockResolvedValue(
      cliStatus({ state: 'not_installed', pathConfigured: false })
    )
    mocks.ensureCli.mockClear()
    mocks.ensureWslCli.mockClear()
    mocks.toastDismiss.mockClear()
    mocks.toastWarning.mockClear()
    mocks.toastWarning.mockReturnValue('linear-setup-toast-id')
    mocks.panelProps.length = 0
    window.localStorage.clear()
    _linearAgentSkillSetupPromptInternalsForTests.resetSessionReminders()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: {
          getInstallStatus: mocks.getCliStatus,
          getWslInstallStatus: mocks.getWslCliStatus
        }
      }
    })
  })

  afterEach(async () => {
    await unmountPrompt()
    window.localStorage.clear()
    _linearAgentSkillSetupPromptInternalsForTests.resetSessionReminders()
    Reflect.deleteProperty(window, 'api')
  })

  it('shows a warning toast on a later modal-only activation after Not now', async () => {
    await snoozeInitialModal({ linked: true, remote: false, surface: 'modal' })
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    expect(document.body.textContent).not.toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(toast.warning).toHaveBeenCalledWith(
      'Orca CLI and Linear skill are missing',
      expect.objectContaining({
        id: 'linear-agent-skill-setup-orca.linearTicketsSkill.setupDismissed.host',
        description:
          'Install the Orca CLI and the Linear skill to enable your agents to read and edit Linear tasks.',
        action: {
          label: 'Set up',
          onClick: expect.any(Function)
        }
      })
    )
  })

  it('does not repeat the Orca CLI in CLI-only reminder toast copy', async () => {
    mocks.skillState.installed = true
    await snoozeInitialModal({ linked: true, remote: false, surface: 'modal' })
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    expect(toast.warning).toHaveBeenCalledWith(
      'Orca CLI is missing',
      expect.objectContaining({
        description: 'Install the Orca CLI to enable your agents to read and edit Linear tasks.'
      })
    )
  })

  it('keeps remote setup nuance in reminder toast copy', async () => {
    await snoozeInitialModal({ linked: true, remote: true, surface: 'modal' })
    await renderPrompt({ linked: true, remote: true, surface: 'modal' })

    expect(toast.warning).toHaveBeenCalledWith(
      'Orca CLI and Linear skill are missing',
      expect.objectContaining({
        description:
          'Install the Orca CLI and the Linear skill to enable your agents to read and edit Linear tasks. Remote agent environments may need their own setup.'
      })
    )
  })

  it('keeps WSL target nuance in reminder toast copy', async () => {
    const wslProps = {
      linked: true,
      remote: false,
      surface: 'modal',
      currentPlatform: 'win32',
      settings: {
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Fedora',
        terminalWindowsShell: 'wsl.exe',
        activeRuntimeEnvironmentId: null
      }
    } satisfies ComponentProps<typeof LinearAgentSkillSetupPrompt>
    await snoozeInitialModal(wslProps)
    await renderPrompt(wslProps)

    expect(toast.warning).toHaveBeenCalledWith(
      'Orca CLI and Linear skill are missing',
      expect.objectContaining({
        description:
          'Install the Orca CLI and the Linear skill to enable your agents to read and edit Linear tasks. This setup runs in the selected WSL agent runtime.'
      })
    )
  })

  it('opens the setup dialog from the reminder toast action', async () => {
    await snoozeInitialModal({ linked: true, remote: false, surface: 'modal' })
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    const action = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]?.action as
      | ReminderToastAction
      | undefined
    await act(async () => {
      action?.onClick?.()
    })

    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(document.body.textContent).toContain('Mock install')
    expect(toast.dismiss).toHaveBeenCalledWith(
      'linear-agent-skill-setup-orca.linearTicketsSkill.setupDismissed.host'
    )
  })

  it('dismisses an active reminder toast on permanent dismissal', async () => {
    await snoozeInitialModal({ linked: true, remote: false, surface: 'modal' })
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    const action = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]?.action as
      | ReminderToastAction
      | undefined
    await act(async () => {
      action?.onClick?.()
    })
    mocks.toastDismiss.mockClear()
    await act(async () => {
      findBodyButton("Don't show again")?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBe('1')
    expect(toast.dismiss).not.toHaveBeenCalled()
  })
})
