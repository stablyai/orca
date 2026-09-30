// @vitest-environment happy-dom

import { act, type ComponentProps, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LINEAR_AGENT_SKILL_NAMES } from '@/lib/agent-feature-install-commands'
import {
  LinearAgentSkillSetupPrompt,
  _linearAgentSkillSetupPromptInternalsForTests
} from './LinearAgentSkillSetupPrompt'
import type { LinearAgentSkillPromptSettings } from './linear-agent-skill-runtime'

const HOST_DISMISS_STORAGE_KEY = 'orca.linearTicketsSkill.setupDismissed.host'
const FEDORA_DISMISS_STORAGE_KEY = 'orca.linearTicketsSkill.setupDismissed.wsl.Fedora'

const projectHostRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'repo-1',
    reason: 'project-override',
    cacheKey: 'repo-1:windows-host'
  }
}

const projectWslRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}

const mocks = vi.hoisted(() => ({
  skillState: {
    installed: false,
    loading: false,
    error: null as string | null,
    skills: [],
    refresh: vi.fn(async () => {})
  },
  useInstalledAgentSkillNames: vi.fn(),
  getCliStatus: vi.fn(),
  getWslCliStatus: vi.fn(),
  panelProps: [] as Record<string, unknown>[]
}))

vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  useInstalledAgentSkillNames: mocks.useInstalledAgentSkillNames
}))

vi.mock('../settings/CliSkillRuntimeSetup', () => ({
  buildSkillCommandForRuntime: (
    command: string,
    _runtime: { runtime: string; wslDistro?: string | null }
  ) => command
}))

vi.mock('../settings/AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: Record<string, unknown> & { children?: ReactNode }) => {
    mocks.panelProps.push(props)
    return (
      <section data-testid="linear-skill-inline-panel">
        <h2>{String(props.title)}</h2>
        <p>{String(props.description)}</p>
        <code>{String(props.command)}</code>
        <button
          type="button"
          onClick={() => {
            if (typeof props.onBeforeOpenTerminal === 'function') {
              void props.onBeforeOpenTerminal()
            }
          }}
        >
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

function wslSettings(distro: string): LinearAgentSkillPromptSettings {
  return {
    localAgentRuntime: 'wsl',
    localAgentWslDistro: distro,
    terminalWindowsShell: 'wsl.exe',
    activeRuntimeEnvironmentId: null
  }
}

function wslPromptProps(
  distro: string,
  surface: 'inline' | 'modal' = 'inline'
): ComponentProps<typeof LinearAgentSkillSetupPrompt> {
  return {
    linked: true,
    remote: false,
    surface,
    currentPlatform: 'win32',
    settings: wslSettings(distro)
  }
}

function expectNoCliStatusQuery(): void {
  expect(mocks.getCliStatus).not.toHaveBeenCalled()
  expect(mocks.getWslCliStatus).not.toHaveBeenCalled()
}

let root: Root | null = null
let container: HTMLDivElement | null = null

function installLocalStorageShim(): void {
  const values = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value)
    }
  })
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
  if (props.surface === 'modal') {
    await import('./LinearAgentSkillSetupDialog')
  }
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

async function settleRender(): Promise<void> {
  await import('./LinearAgentSkillSetupDialog')
  await act(async () => {})
  await act(async () => {})
}

async function showSuccessfulModalRecheck(): Promise<void> {
  await renderPrompt({ linked: true, remote: false, surface: 'modal' })

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
    Object.assign(mocks.skillState, { installed: false, loading: false, error: null, skills: [] })
    mocks.skillState.refresh.mockReset().mockImplementation(async () => {})
    mocks.useInstalledAgentSkillNames.mockReset()
    mocks.useInstalledAgentSkillNames.mockReturnValue(mocks.skillState)
    mocks.getCliStatus.mockReset()
    mocks.getWslCliStatus.mockReset()
    mocks.panelProps.length = 0
    installLocalStorageShim()
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

  it('shows a compact host setup prompt about only the skill when it is missing', async () => {
    const rendered = await renderPrompt({ linked: true, remote: false })

    expect(rendered.textContent).toContain('Set up Linear agent skill')
    expect(rendered.textContent).toContain('Linear agent skill is missing.')
    expect(rendered.textContent).not.toContain('Orca CLI')
    expect(rendered.textContent).toContain('Install it for host agent handoffs')
    expectNoCliStatusQuery()
    expect(mocks.useInstalledAgentSkillNames).toHaveBeenCalledWith(
      LINEAR_AGENT_SKILL_NAMES,
      expect.objectContaining({ enabled: true, sourceKinds: ['home'] })
    )
  })

  it('hides when the prompt is not linked or both prerequisites are ready', async () => {
    mocks.skillState.installed = true

    const unlinked = await renderPrompt({ linked: false, remote: false })
    expect(unlinked.textContent).not.toContain('Set up Linear agent skill')

    await unmountPrompt()

    const ready = await renderPrompt({ linked: true, remote: false })
    expect(ready.textContent).not.toContain('Set up Linear agent skill')
  })

  it.each([false, true])(
    'treats installed skills as ready without registration (WSL: %s)',
    async (managedWsl) => {
      const props = managedWsl ? wslPromptProps('Fedora') : { linked: true, remote: false }
      mocks.skillState.installed = true

      const inline = await renderPrompt(props)
      expect(inline.textContent).not.toContain('Set up Linear agent skill')

      await unmountPrompt()

      await renderPrompt({ ...props, surface: 'modal' })
      expect(document.body.textContent).not.toContain(
        'Enable agents to read and edit the attached Linear ticket.'
      )
      expectNoCliStatusQuery()
    }
  )

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
        activeRuntimeEnvironmentId: 'runtime-1'
      }
    })

    expect(rendered.textContent).toContain('remote agent environments may need separate setup')
    expectNoCliStatusQuery()
    expect(mocks.useInstalledAgentSkillNames).toHaveBeenCalledWith(
      LINEAR_AGENT_SKILL_NAMES,
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

  it('uses WSL skill discovery and commands without CLI registration', async () => {
    const rendered = await renderPrompt({
      linked: true,
      remote: false,
      currentPlatform: 'win32',
      settings: wslSettings('Fedora')
    })

    expect(mocks.getCliStatus).not.toHaveBeenCalled()
    expect(mocks.getWslCliStatus).not.toHaveBeenCalled()
    expect(mocks.useInstalledAgentSkillNames).toHaveBeenCalledWith(
      LINEAR_AGENT_SKILL_NAMES,
      expect.objectContaining({
        discoveryTarget: { runtime: 'wsl', wslDistro: 'Fedora' },
        enabled: true,
        sourceKinds: ['home']
      })
    )
    expect(rendered.textContent).toContain('Linear agent skill is missing.')
    expect(rendered.textContent).toContain('Install it for WSL agent handoffs')

    const setupButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Set up'
    )
    await act(async () => {
      setupButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    expect(document.body.textContent).toContain('npx skills add')
    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({
        installedCommand: 'npx skills update orca-linear --global',
        terminalShellOverride: 'powershell.exe',
        terminalRuntime: expect.objectContaining({ runtime: 'wsl', wslDistro: 'Fedora' })
      })
    )
    expect(mocks.panelProps.at(-1)?.getPrerequisiteStatus).toBeUndefined()
    expect(mocks.panelProps.at(-1)?.preInstallNotice).toBeUndefined()

    const installButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Mock install'
    )
    await act(async () => {
      installButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  })

  it('persists WSL dismissal by selected distro', async () => {
    const rendered = await renderPrompt({
      linked: true,
      remote: false,
      currentPlatform: 'win32',
      settings: wslSettings('Fedora')
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

    expect(mocks.getWslCliStatus).not.toHaveBeenCalled()
  })

  it('keeps stale terminal WSL settings on host when project runtime is absent', async () => {
    await renderPrompt({
      linked: true,
      remote: false,
      currentPlatform: 'win32',
      settings: {
        terminalWindowsShell: 'wsl.exe',
        activeRuntimeEnvironmentId: null
      }
    })

    expect(container?.textContent).toContain('Install it for host agent handoffs')
    expectNoCliStatusQuery()
  })

  it('keeps the prompt usable and loads the lazy setup dialog only when requested', async () => {
    const rendered = await renderPrompt({ linked: true, remote: false })

    expect(document.body.querySelector('[data-testid="linear-skill-inline-panel"]')).toBeNull()

    const setupButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Set up'
    )
    await act(async () => {
      setupButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()

    expect(document.body.querySelector('[data-testid="linear-skill-inline-panel"]')).not.toBeNull()
    expect(document.body.textContent).toContain('orca-linear')

    const installButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Mock install'
    )
    await act(async () => {
      installButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.panelProps.at(-1)?.preInstallNotice).toBeUndefined()
    expect(mocks.panelProps.at(-1)?.getPrerequisiteStatus).toBeUndefined()
    expectNoCliStatusQuery()
  })

  it('auto-opens as a modal-only prompt and treats the × close as a casual snooze', async () => {
    await renderPrompt({ linked: true, remote: false, surface: 'modal' })

    expect(container?.textContent).not.toContain('Set up Linear agent skill')
    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(document.body.textContent).toContain('Linear agent skill is missing.')
    expect(document.body.textContent).toContain('Mock install')
    // Why: the permanent opt-out is an EyeOff icon (no visible text); the casual
    // dismiss is the dialog ×. Neither "Not now" nor any dismiss label shows as text.
    expect(document.body.textContent).not.toContain('Not now')
    expect(mocks.panelProps.at(-1)?.preInstallNotice).toBeUndefined()

    // Why: the × must snooze for the session, not persist a permanent dismissal.
    const closeButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Close'
    )
    await act(async () => {
      closeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

    mocks.skillState.refresh.mockImplementationOnce(async () => {
      mocks.skillState.installed = true
    })

    const recheckButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Re-check'
    )
    await act(async () => {
      recheckButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    // Why: the real skill hook re-renders on refresh; this mock only mutates a shared object.
    await updatePrompt({ linked: true, remote: false })

    expect(mocks.skillState.refresh).toHaveBeenCalled()
    expect(rendered.textContent).not.toContain('Set up Linear agent skill')
    expectNoCliStatusQuery()
  })

  it('keeps the missing setup modal visible after a partial Re-check', async () => {
    await renderPrompt(wslPromptProps('Fedora', 'modal'))

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
    const props = wslPromptProps('Fedora', 'modal')
    await renderPrompt(props)
    let resolveSkillRefresh: () => void = () => {}
    mocks.skillState.refresh.mockImplementation(() => {
      mocks.skillState.loading = true
      return new Promise<void>((resolve) => {
        resolveSkillRefresh = resolve
      })
    })

    await act(async () => {
      findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await updatePrompt(props)
    expect(document.body.textContent).toContain(
      'Enable agents to read and edit the attached Linear ticket.'
    )
    expect(mocks.panelProps.at(-1)).toEqual(expect.objectContaining({ loading: true }))

    mocks.skillState.installed = true
    mocks.skillState.loading = false
    resolveSkillRefresh()
    await updatePrompt(props)
    expect(document.body.textContent).toContain('Linear ticket access is ready')
  })

  it('does not keep a new runtime disabled while the previous skill refresh is pending', async () => {
    await renderPrompt(wslPromptProps('Fedora', 'modal'))
    let finishRefresh: () => void = () => {}
    mocks.skillState.refresh.mockImplementation(() => {
      mocks.skillState.loading = true
      return new Promise<void>((resolve) => {
        finishRefresh = resolve
      })
    })
    await act(async () => {
      findBodyButton('Re-check')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.panelProps.at(-1)).toEqual(expect.objectContaining({ loading: true }))

    // The skill hook owns loading for the new target, independently of the old request.
    mocks.skillState.loading = false
    await updatePrompt(wslPromptProps('Ubuntu', 'modal'))
    expect(mocks.panelProps.at(-1)).toEqual(expect.objectContaining({ loading: false }))
    finishRefresh()
    await settleRender()
    expect(document.body.textContent).not.toContain('Linear ticket access is ready')
  })

  it('uses WSL-specific success copy for a selected WSL runtime', async () => {
    await renderPrompt({
      linked: true,
      remote: false,
      surface: 'modal',
      currentPlatform: 'win32',
      settings: wslSettings('Fedora')
    })

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

  it('uses project host runtime for skill discovery when legacy settings still point at WSL', async () => {
    await renderPrompt({
      linked: true,
      remote: false,
      currentPlatform: 'win32',
      projectRuntime: projectHostRuntime,
      settings: wslSettings('Fedora')
    })

    expect(mocks.useInstalledAgentSkillNames).toHaveBeenLastCalledWith(
      LINEAR_AGENT_SKILL_NAMES,
      expect.objectContaining({
        discoveryTarget: { projectRuntime: projectHostRuntime }
      })
    )
    expectNoCliStatusQuery()
  })

  it('uses selected project WSL runtime for skill discovery without checking CLI status', async () => {
    const rendered = await renderPrompt({
      linked: true,
      remote: false,
      currentPlatform: 'win32',
      projectRuntime: projectWslRuntime,
      settings: {
        localAgentRuntime: 'host',
        terminalWindowsShell: 'powershell.exe',
        activeRuntimeEnvironmentId: null
      }
    })

    expect(mocks.useInstalledAgentSkillNames).toHaveBeenLastCalledWith(
      LINEAR_AGENT_SKILL_NAMES,
      expect.objectContaining({
        discoveryTarget: { projectRuntime: projectWslRuntime }
      })
    )
    expect(mocks.getWslCliStatus).not.toHaveBeenCalled()
    expect(mocks.getCliStatus).not.toHaveBeenCalled()
    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Set up')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settleRender()
    expect(mocks.panelProps.at(-1)?.command).toContain('npx skills add')
    expect(mocks.panelProps.at(-1)?.terminalRuntime).toEqual(
      expect.objectContaining({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    )
  })

  it('uses remote-safe success copy for remote workspaces', async () => {
    await renderPrompt({ linked: true, remote: true, surface: 'modal' })

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

    // Why: permanent dismiss is now an EyeOff icon button (aria-label, no text).
    const dismissButton = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Don\'t show again"]'
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
