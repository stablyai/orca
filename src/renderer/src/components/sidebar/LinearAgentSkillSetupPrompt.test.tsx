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
        <button
          type="button"
          disabled={Boolean(props.loading)}
          data-loading={String(Boolean(props.loading))}
          onClick={() => void (props.onRecheck as () => void | Promise<void>)()}
        >
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

async function updatePrompt(
  props: ComponentProps<typeof LinearAgentSkillSetupPrompt>
): Promise<void> {
  await act(async () => {
    root?.render(<LinearAgentSkillSetupPrompt {...props} />)
  })
  await act(async () => {})
}

function findBodyButton(label: string): HTMLButtonElement | undefined {
  return Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent === label
  )
}

async function settleRender(): Promise<void> {
  await act(async () => {})
  await act(async () => {})
}

async function showSuccessfulModalRecheck(): Promise<void> {
  await renderPrompt({ linked: true, remote: false, surface: 'modal' })

  mocks.getCliStatus.mockResolvedValue(cliStatus({}))
  mocks.skillState.refresh.mockImplementationOnce(async () => {
    mocks.skillState.installed = true
  })

  await act(async () => {
    findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settleRender()
}

describe('LinearAgentSkillSetupPrompt', () => {
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

  it('keeps the modal open with success copy after a modal Re-check succeeds', async () => {
    await showSuccessfulModalRecheck()

    expect(document.body.textContent).toContain('Linear ticket access is ready')
    expect(document.body.textContent).toContain(
      'Agents can now read and update linked Linear tickets from this workspace.'
    )
    expect(document.body.textContent).toContain('Linear ticket access ready')
    expect(document.body.textContent).not.toContain('Mock install')
    expect(document.body.textContent).not.toContain("Don't show again")
    expect(document.body.textContent).not.toContain('Not now')
  })

  it('closes success with Done without permanent dismissal or session snooze', async () => {
    await showSuccessfulModalRecheck()

    await act(async () => {
      findBodyButton('Done')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBeNull()
    expect(document.body.textContent).not.toContain('Linear ticket access is ready')

    await act(async () => {
      root?.unmount()
    })
    root = null
    container?.remove()
    container = null

    mocks.getCliStatus.mockResolvedValue(
      cliStatus({ state: 'not_installed', pathConfigured: false })
    )
    mocks.skillState.installed = false

    await renderPrompt({ linked: true, remote: false, surface: 'modal' })
    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
  })

  it('closes success with the dialog close button without permanent dismissal or session snooze', async () => {
    await showSuccessfulModalRecheck()

    await act(async () => {
      findBodyButton('Close')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBeNull()
    expect(document.body.textContent).not.toContain('Linear ticket access is ready')

    await act(async () => {
      root?.unmount()
    })
    root = null
    container?.remove()
    container = null

    mocks.getCliStatus.mockResolvedValue(
      cliStatus({ state: 'not_installed', pathConfigured: false })
    )
    mocks.skillState.installed = false

    await renderPrompt({ linked: true, remote: false, surface: 'modal' })
    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
  })

  it('closes success with Escape without permanent dismissal or session snooze', async () => {
    await showSuccessfulModalRecheck()

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await settleRender()

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBeNull()
    expect(document.body.textContent).not.toContain('Linear ticket access is ready')
  })

  it('closes success with outside click without permanent dismissal or session snooze', async () => {
    await showSuccessfulModalRecheck()

    const overlay = document.body.querySelector('[data-slot="dialog-overlay"]')
    await act(async () => {
      overlay?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      overlay?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
      overlay?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    expect(window.localStorage.getItem(HOST_DISMISS_STORAGE_KEY)).toBeNull()
    expect(document.body.textContent).not.toContain('Linear ticket access is ready')
  })

  it('still removes the inline prompt after an inline Re-check succeeds', async () => {
    const rendered = await renderPrompt({ linked: true, remote: false })

    mocks.getCliStatus.mockResolvedValue(cliStatus({}))
    mocks.skillState.refresh.mockImplementationOnce(async () => {
      mocks.skillState.installed = true
    })

    const recheckButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Re-check'
    )
    await act(async () => {
      recheckButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    expect(rendered.textContent).not.toContain('Set up Linear agent skill')
  })

  it('keeps the missing setup modal visible after a partial Re-check', async () => {
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    mocks.getCliStatus.mockResolvedValue(cliStatus({}))

    await act(async () => {
      findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(document.body.textContent).toContain('Linear agent skill is missing.')
    expect(document.body.textContent).not.toContain('Linear ticket access is ready')
  })

  it('keeps the modal mounted and the Re-check action loading during a slow modal check', async () => {
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    let resolveCliStatus: (status: CliInstallStatus) => void = () => {}
    let resolveSkillRefresh: () => void = () => {}
    mocks.getCliStatus.mockReturnValue(
      new Promise<CliInstallStatus>((resolve) => {
        resolveCliStatus = resolve
      })
    )
    mocks.skillState.refresh.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveSkillRefresh = resolve
      })
    )

    await act(async () => {
      findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(mocks.panelProps.at(-1)).toEqual(expect.objectContaining({ loading: true }))

    resolveCliStatus(cliStatus({}))
    mocks.skillState.installed = true
    resolveSkillRefresh()
    await settleRender()
  })

  it('ignores stale CLI success after the runtime context changes during Re-check', async () => {
    await renderPrompt({
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
    })

    let resolveWslStatus: (status: CliInstallStatus) => void = () => {}
    mocks.getWslCliStatus.mockReturnValueOnce(
      new Promise<CliInstallStatus>((resolve) => {
        resolveWslStatus = resolve
      })
    )
    mocks.skillState.refresh.mockReturnValueOnce(Promise.resolve())

    await act(async () => {
      findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    mocks.getCliStatus.mockResolvedValue(
      cliStatus({ state: 'not_installed', pathConfigured: false })
    )
    mocks.skillState.installed = true
    await updatePrompt({
      linked: true,
      remote: false,
      surface: 'modal',
      currentPlatform: 'win32',
      settings: {
        localAgentRuntime: 'host',
        terminalWindowsShell: 'powershell.exe',
        activeRuntimeEnvironmentId: null
      }
    })

    resolveWslStatus(cliStatus({}))
    await settleRender()

    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(document.body.textContent).toContain('Orca CLI is missing.')
    expect(document.body.textContent).not.toContain('Linear ticket access is ready')
  })

  it('ignores stale prerequisite CLI status callbacks after the runtime context changes', async () => {
    let reportHostCliStatus: ((status: CliInstallStatus) => void) | null = null
    mocks.ensureCli.mockImplementationOnce(
      async (options?: { onStatusChange?: (status: CliInstallStatus) => void }) => {
        reportHostCliStatus = options?.onStatusChange ?? null
        return null
      }
    )
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    await act(async () => {
      findBodyButton('Mock install')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    mocks.getWslCliStatus.mockResolvedValue(
      cliStatus({ state: 'not_installed', pathConfigured: false })
    )
    mocks.skillState.installed = true
    await updatePrompt({
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
    })

    await act(async () => {
      reportHostCliStatus?.(cliStatus({}))
    })
    await settleRender()

    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(document.body.textContent).toContain('Orca CLI is missing.')
    expect(document.body.textContent).not.toContain('Linear ticket access is ready')
  })

  it('accepts same-context prerequisite CLI status callbacks after a newer Re-check', async () => {
    let reportHostCliStatus: ((status: CliInstallStatus) => void) | null = null
    let resolveEnsureCli: () => void = () => {}
    mocks.ensureCli.mockImplementationOnce(
      async (options?: { onStatusChange?: (status: CliInstallStatus) => void }) => {
        reportHostCliStatus = options?.onStatusChange ?? null
        await new Promise<void>((resolve) => {
          resolveEnsureCli = resolve
        })
        return null
      }
    )
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    await act(async () => {
      findBodyButton('Mock install')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    mocks.getCliStatus.mockResolvedValue(
      cliStatus({ state: 'not_installed', pathConfigured: false })
    )
    await act(async () => {
      findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    await act(async () => {
      reportHostCliStatus?.(cliStatus({}))
      resolveEnsureCli()
    })
    await settleRender()

    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(document.body.textContent).toContain('Linear agent skill is missing.')
    expect(document.body.textContent).not.toContain('Orca CLI is missing.')
  })

  it('ignores older same-context CLI refreshes that finish after a newer Re-check', async () => {
    const rendered = await renderPrompt({ linked: true, remote: false })
    const recheckButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Re-check'
    )
    let resolveOlderCliStatus: (status: CliInstallStatus) => void = () => {}
    mocks.getCliStatus.mockReturnValueOnce(
      new Promise<CliInstallStatus>((resolve) => {
        resolveOlderCliStatus = resolve
      })
    )
    mocks.getCliStatus.mockResolvedValue(cliStatus({}))
    mocks.skillState.refresh.mockImplementation(async () => {
      mocks.skillState.installed = true
    })

    await act(async () => {
      recheckButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      recheckButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    expect(rendered.textContent).not.toContain('Set up Linear agent skill')

    resolveOlderCliStatus(cliStatus({ state: 'not_installed', pathConfigured: false }))
    await settleRender()

    expect(rendered.textContent).not.toContain('Set up Linear agent skill')
  })

  it('uses WSL-specific success copy for a selected WSL runtime', async () => {
    await renderPrompt({
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
    })

    mocks.getWslCliStatus.mockResolvedValue(cliStatus({}))
    mocks.skillState.refresh.mockImplementationOnce(async () => {
      mocks.skillState.installed = true
    })

    await act(async () => {
      findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    expect(document.body.textContent).toContain(
      'WSL agents can now use linked Linear tickets from this workspace.'
    )
  })

  it('uses remote-safe success copy for remote workspaces', async () => {
    await renderPrompt({ linked: true, remote: true, surface: 'modal' })

    mocks.getCliStatus.mockResolvedValue(cliStatus({}))
    mocks.skillState.refresh.mockImplementationOnce(async () => {
      mocks.skillState.installed = true
    })

    await act(async () => {
      findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    expect(document.body.textContent).toContain(
      'Host agents can now use linked Linear tickets. Remote agent environments may still need their own setup.'
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
