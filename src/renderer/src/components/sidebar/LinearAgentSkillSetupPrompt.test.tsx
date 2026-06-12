// @vitest-environment happy-dom

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  LinearAgentSkillSetupPrompt,
  _linearAgentSkillSetupPromptInternalsForTests
} from './LinearAgentSkillSetupPrompt'

const HOST_DISMISS_STORAGE_KEY = 'orca.linearTicketsSkill.setupDismissed.host'
const FEDORA_DISMISS_STORAGE_KEY = 'orca.linearTicketsSkill.setupDismissed.wsl.Fedora'

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
  panelProps: [] as Record<string, unknown>[]
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
  buildSkillInstallCommandForRuntime: (
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
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<LinearAgentSkillSetupPrompt {...props} />)
  })
  await act(async () => {})
  return container
}

describe('LinearAgentSkillSetupPrompt', () => {
  beforeEach(() => {
    mocks.skillState.installed = false
    mocks.skillState.loading = false
    mocks.skillState.error = null
    mocks.skillState.refresh.mockClear()
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
    mocks.panelProps.length = 0
    window.localStorage.clear()
    _linearAgentSkillSetupPromptInternalsForTests.resetSessionSnoozes()
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
    if (root) {
      await act(async () => {
        root?.unmount()
      })
    }
    root = null
    container?.remove()
    container = null
    window.localStorage.clear()
    _linearAgentSkillSetupPromptInternalsForTests.resetSessionSnoozes()
    Reflect.deleteProperty(window, 'api')
  })

  it('shows a compact setup prompt when a linked Linear worktree is missing CLI or skill setup', async () => {
    const rendered = await renderPrompt({ linked: true, remote: false })

    expect(rendered.textContent).toContain('Set up Linear agent skill')
    expect(rendered.textContent).toContain('Orca CLI and Linear agent skill are missing')
    expect(rendered.textContent).toContain('Install it for host agent handoffs')
    expect(mocks.useInstalledAgentSkill).toHaveBeenCalledWith(
      'linear-tickets',
      expect.objectContaining({ enabled: true, sourceKinds: ['home'] })
    )
  })

  it('hides when the prompt is not linked or both prerequisites are ready', async () => {
    mocks.getCliStatus.mockResolvedValue(cliStatus({}))
    mocks.skillState.installed = true

    const unlinked = await renderPrompt({ linked: false, remote: false })
    expect(unlinked.textContent).not.toContain('Set up Linear agent skill')

    await act(async () => {
      root?.unmount()
    })
    root = null
    unlinked.remove()
    container = null

    const ready = await renderPrompt({ linked: true, remote: false })
    expect(ready.textContent).not.toContain('Set up Linear agent skill')
  })

  it('persists host dismissal forever for the host setup target', async () => {
    const rendered = await renderPrompt({ linked: true, remote: false })

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss Linear agent skill setup"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBe('1')
    expect(rendered.textContent).not.toContain('Set up Linear agent skill')
  })

  it('persists remote dismissal and uses remote-safe copy', async () => {
    const rendered = await renderPrompt({
      linked: true,
      remote: true,
      currentPlatform: 'win32',
      settings: {
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Fedora',
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        activeRuntimeEnvironmentId: 'runtime-1'
      }
    })

    expect(rendered.textContent).toContain('remote agent environments may need separate setup')
    expect(mocks.getCliStatus).toHaveBeenCalled()
    expect(mocks.getWslCliStatus).not.toHaveBeenCalled()
    expect(mocks.useInstalledAgentSkill).toHaveBeenCalledWith(
      'linear-tickets',
      expect.objectContaining({
        discoveryTarget: undefined,
        enabled: true,
        sourceKinds: ['home']
      })
    )

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss Linear agent skill setup"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBe('1')
    expect(rendered.textContent).not.toContain('Set up Linear agent skill')
  })

  it('uses WSL discovery, status, command, and prerequisite setup together', async () => {
    const rendered = await renderPrompt({
      linked: true,
      remote: false,
      currentPlatform: 'win32',
      settings: {
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Fedora',
        terminalWindowsShell: 'wsl.exe',
        terminalWindowsWslDistro: 'Ubuntu',
        activeRuntimeEnvironmentId: null
      }
    })

    expect(mocks.getCliStatus).not.toHaveBeenCalled()
    expect(mocks.getWslCliStatus).toHaveBeenCalledWith({ distro: 'Fedora' })
    expect(mocks.useInstalledAgentSkill).toHaveBeenCalledWith(
      'linear-tickets',
      expect.objectContaining({
        discoveryTarget: { runtime: 'wsl', wslDistro: 'Fedora' },
        enabled: true,
        sourceKinds: ['home']
      })
    )
    expect(rendered.textContent).toContain('Install it for WSL agent handoffs')

    const setupButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Set up'
    )
    await act(async () => {
      setupButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain("wsl.exe -d 'Fedora' -- bash -lc 'npx skills add")
    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({
        terminalShellOverride: 'powershell.exe',
        getPrerequisiteStatus: expect.any(Function)
      })
    )
    const getPrerequisiteStatus = mocks.panelProps.at(-1)?.getPrerequisiteStatus
    expect(getPrerequisiteStatus).toEqual(expect.any(Function))
    await (getPrerequisiteStatus as () => Promise<unknown>)()
    expect(mocks.getWslCliStatus).toHaveBeenLastCalledWith({ distro: 'Fedora' })

    const installButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Mock install'
    )
    await act(async () => {
      installButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.ensureWslCli).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'wsl', wslDistro: 'Fedora' })
    )
    expect(mocks.ensureCli).not.toHaveBeenCalled()
  })

  it('persists WSL dismissal by selected distro', async () => {
    const rendered = await renderPrompt({
      linked: true,
      remote: false,
      currentPlatform: 'win32',
      settings: {
        localAgentRuntime: 'wsl',
        localAgentWslDistro: 'Fedora',
        terminalWindowsShell: 'wsl.exe',
        activeRuntimeEnvironmentId: null
      }
    })

    await act(async () => {
      rendered
        .querySelector<HTMLButtonElement>('button[aria-label="Dismiss Linear agent skill setup"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.localStorage.getItem(FEDORA_DISMISS_STORAGE_KEY)).toBe('1')
    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBeNull()
    expect(rendered.textContent).not.toContain('Set up Linear agent skill')
  })

  it('omits the WSL CLI distro request for default WSL setup', async () => {
    await renderPrompt({
      linked: true,
      remote: false,
      currentPlatform: 'win32',
      settings: {
        localAgentRuntime: 'wsl',
        terminalWindowsShell: 'wsl.exe',
        activeRuntimeEnvironmentId: null
      }
    })

    expect(mocks.getWslCliStatus).toHaveBeenCalledWith(undefined)
  })

  it('opens the terminal setup panel in a dialog only after the user asks to set up', async () => {
    const rendered = await renderPrompt({ linked: true, remote: false })

    expect(document.body.querySelector('[data-testid="linear-skill-inline-panel"]')).toBeNull()

    const setupButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Set up'
    )
    await act(async () => {
      setupButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.querySelector('[data-testid="linear-skill-inline-panel"]')).not.toBeNull()
    expect(document.body.textContent).toContain('linear-tickets')

    const installButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Mock install'
    )
    await act(async () => {
      installButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.ensureCli).toHaveBeenCalledWith(
      expect.objectContaining({ onStatusChange: expect.any(Function) })
    )
  })

  it('auto-opens as a modal-only prompt and session-snoozes when closed', async () => {
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    expect(container?.textContent).not.toContain('Set up Linear agent skill')
    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(document.body.textContent).toContain('Orca CLI and Linear agent skill are missing.')
    expect(document.body.textContent).toContain('Mock install')
    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({
        preInstallNotice: 'CLI registration notice'
      })
    )

    const notNowButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Not now'
    )
    await act(async () => {
      notNowButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBeNull()
    expect(document.body.textContent).not.toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
  })

  it('permanently dismisses the modal-only prompt when requested', async () => {
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    const dismissButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === "Don't show again"
    )
    await act(async () => {
      dismissButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBe('1')
    expect(document.body.textContent).not.toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
  })
})
