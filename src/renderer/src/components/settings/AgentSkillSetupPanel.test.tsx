// @vitest-environment happy-dom

import { act, useState, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { TooltipProvider } from '../ui/tooltip'

const INSTALL_COMMAND = 'npx skills add https://github.com/stablyai/orca --skill orca-cli --global'
const UPDATE_COMMAND = 'npx skills update orca-cli --global'

const mocks = vi.hoisted(() => ({
  clipboardWrite: vi.fn(),
  terminalProps: [] as {
    command: string
    description: string
    shellOverride?: string
    prepareCommandForShell?: (command: string, shellOverride?: string) => string
    onTerminalExit?: () => void
    onCommandFinished?: (bestEffortExitCode: number | null) => void
  }[],
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  skillsChanged: vi.fn(),
  skillsRefreshed: vi.fn(),
  freshnessRefresh: vi.fn(),
  terminalInstanceCount: 0
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsChanged: mocks.skillsChanged,
  notifyInstalledAgentSkillsRefreshed: mocks.skillsRefreshed
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: mocks.freshnessRefresh
}))

vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: {
    command: string
    description: string
    shellOverride?: string
    prepareCommandForShell?: (command: string, shellOverride?: string) => string
    onTerminalExit?: () => void
    onCommandFinished?: (bestEffortExitCode: number | null) => void
  }) => {
    const [instance] = useState(() => {
      mocks.terminalInstanceCount += 1
      return mocks.terminalInstanceCount
    })
    mocks.terminalProps.push(props)
    return (
      <div
        data-testid="inline-command-terminal"
        data-command={props.command}
        data-description={props.description}
        data-instance={instance}
      >
        {props.command}
      </div>
    )
  }
}))

vi.mock('../skills/SkillFreshnessStatusPill', () => ({
  SkillFreshnessStatusPill: ({ skillName }: { skillName: string }) => (
    <span data-testid="skill-freshness">{skillName}</span>
  )
}))

function panelProps(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): ComponentProps<typeof AgentSkillSetupPanel> {
  return {
    title: 'CLI skill',
    description: 'Enables agents to use Orca workflows.',
    command: INSTALL_COMMAND,
    terminalTitle: 'CLI skill setup',
    terminalAriaLabel: 'CLI skill install terminal',
    terminalWorktreeId: 'settings-cli-skill-terminal',
    installed: false,
    loading: false,
    error: null,
    onRecheck: vi.fn(),
    ...overrides
  }
}

function renderPanel(overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}): string {
  return renderToStaticMarkup(<AgentSkillSetupPanel {...panelProps(overrides)} />)
}

function buttonLabels(html: string): string[] {
  return Array.from(html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g), ([, content]) =>
    content
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

function buttonMarkupByLabel(html: string, label: string): string | undefined {
  return Array.from(html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g), ([button]) => button).find(
    (button) => buttonLabels(button).includes(label)
  )
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderInteractivePanel(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await rerenderInteractivePanel(overrides)
  return container
}

async function rerenderInteractivePanel(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): Promise<void> {
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <AgentSkillSetupPanel {...panelProps(overrides)} />
      </TooltipProvider>
    )
  })
  await act(async () => {})
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from((container ?? document.body).querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  expect(button).toBeDefined()
  return button as HTMLButtonElement
}

async function clickButton(label: string): Promise<void> {
  await act(async () => {
    findButton(label).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await act(async () => {})
}

describe('AgentSkillSetupPanel', () => {
  beforeEach(() => {
    mocks.clipboardWrite.mockReset()
    mocks.clipboardWrite.mockResolvedValue(undefined)
    mocks.terminalProps.length = 0
    mocks.toastError.mockReset()
    mocks.toastSuccess.mockReset()
    mocks.skillsChanged.mockReset()
    mocks.skillsRefreshed.mockReset()
    mocks.freshnessRefresh.mockReset()
    mocks.freshnessRefresh.mockResolvedValue(undefined)
    mocks.terminalInstanceCount = 0
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: {
          getInstallStatus: vi.fn()
        },
        ui: {
          writeClipboardText: mocks.clipboardWrite
        },
        platform: {
          get: () => ({ platform: 'win32' })
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
    Reflect.deleteProperty(window, 'api')
  })

  it('keeps the install action visible after the skill is detected', () => {
    const html = renderPanel({ installed: true })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).toContain('Update')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('surfaces skill freshness under hideHeader for guided setup hubs', () => {
    const html = renderPanel({
      installed: true,
      hideHeader: true,
      description: null,
      freshnessSkillName: 'orca-linear'
    })

    expect(html).toContain('data-testid="skill-freshness"')
    expect(html).toContain('orca-linear')
    expect(html).not.toContain('CLI skill')
  })

  it('does not render an empty description paragraph when description is null', () => {
    const html = renderPanel({ description: null, hideHeader: true })

    expect(html).not.toContain('text-muted-foreground">null')
    expect(html).not.toMatch(/<p class="text-\[13px\] leading-snug text-muted-foreground"><\/p>/)
  })

  it('hides only re-check when installed re-checks are disabled', () => {
    const html = renderPanel({ installed: true, showRecheckWhenInstalled: false })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).toContain('Update')
    expect(buttonLabels(html)).not.toContain('Re-check')
  })

  it('keeps update copy until the installed panel checks CLI prerequisites', () => {
    const html = renderPanel({
      installed: true,
      installLabel: 'Install CLI & Skill',
      preInstallNotice: 'Install the Orca CLI before running agent skill setup.'
    })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).toContain('Update')
    expect(buttonLabels(html)).not.toContain('Install CLI &amp; Skill')
  })

  it('keeps the installed action label when CLI prerequisites are missing', async () => {
    await renderInteractivePanel({
      installed: true,
      installedCommand: UPDATE_COMMAND,
      installLabel: 'Install CLI & Skill',
      preInstallNotice: 'Install the Orca CLI before running agent skill setup.',
      getPrerequisiteStatus: vi.fn(
        async () =>
          ({
            state: 'not_installed'
          }) as Awaited<ReturnType<typeof window.api.cli.getInstallStatus>>
      ),
      isPrerequisiteAvailable: () => false
    })

    expect(findButton('Update').disabled).toBe(false)
    expect(container?.textContent).not.toContain('Install CLI & Skill')
  })

  it('can hide install after the skill is detected', () => {
    const html = renderPanel({ installed: true, showInstallWhenInstalled: false })

    expect(html).toContain('Installed')
    expect(buttonLabels(html)).not.toContain('Install')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('keeps re-check visible before install when installed re-checks are disabled', () => {
    const html = renderPanel({ installed: false, showRecheckWhenInstalled: false })

    expect(buttonLabels(html)).toContain('Install')
    expect(buttonLabels(html)).toContain('Re-check')
  })

  it('keeps install visible but disabled when parent setup is disabled', () => {
    const html = renderPanel({ installDisabled: true })

    expect(buttonMarkupByLabel(html, 'Install')).toContain('disabled=""')
  })

  it('notifies sibling surfaces only after re-check finishes', async () => {
    let finishRecheck: (() => void) | null = null
    const recheck = new Promise<void>((resolve) => {
      finishRecheck = resolve
    })
    await renderInteractivePanel({ onRecheck: () => recheck })

    await clickButton('Re-check')
    expect(mocks.skillsRefreshed).not.toHaveBeenCalled()

    await act(async () => {
      finishRecheck?.()
      await recheck
    })

    expect(mocks.skillsRefreshed).toHaveBeenCalledOnce()
    expect(mocks.skillsChanged).not.toHaveBeenCalled()
  })

  it('rechecks presence without invalidating local freshness when no local verdict exists', async () => {
    const onRecheck = vi.fn(async () => {})
    await renderInteractivePanel({ onRecheck })
    await clickButton('Install')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(0)
      mocks.terminalProps.at(-1)?.onTerminalExit?.()
    })
    await act(async () => {})

    expect(onRecheck).toHaveBeenCalledOnce()
    expect(mocks.skillsRefreshed).toHaveBeenCalledOnce()
    expect(mocks.skillsChanged).not.toHaveBeenCalled()
    expect(mocks.freshnessRefresh).not.toHaveBeenCalled()
  })

  it('refreshes first-install freshness only after the terminal re-check finishes', async () => {
    let finishRecheck: (() => void) | null = null
    const recheck = new Promise<void>((resolve) => {
      finishRecheck = resolve
    })
    const onRecheck = vi.fn(() => recheck)
    await renderInteractivePanel({ freshnessSkillName: 'orca-cli', onRecheck })
    await clickButton('Install')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onTerminalExit?.()
    })

    expect(onRecheck).toHaveBeenCalledOnce()
    expect(mocks.freshnessRefresh).not.toHaveBeenCalled()
    expect(mocks.skillsRefreshed).not.toHaveBeenCalled()

    await act(async () => {
      finishRecheck?.()
      await recheck
    })

    expect(mocks.skillsChanged).not.toHaveBeenCalled()
    expect(mocks.skillsRefreshed).toHaveBeenCalledOnce()
    expect(mocks.freshnessRefresh).toHaveBeenCalledOnce()
  })

  it('opens not-installed setup with the install command for preview, copy, and terminal', async () => {
    await renderInteractivePanel({ installedCommand: UPDATE_COMMAND })

    await clickButton('Install')

    expect(container?.textContent).toContain(INSTALL_COMMAND)
    expect(mocks.terminalProps.at(-1)).toMatchObject({
      command: INSTALL_COMMAND,
      description: 'Press Enter to run the command.'
    })

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.clipboardWrite).toHaveBeenCalledWith(INSTALL_COMMAND)
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Copied command.')
  })

  it('copies the POSIX WSL command while the setup pane runs the PowerShell wrapper', async () => {
    await renderInteractivePanel({
      terminalShellOverride: 'powershell.exe',
      terminalRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' }
    })

    await clickButton('Install')

    const terminalProps = mocks.terminalProps.at(-1)
    expect(terminalProps?.command).toBe(INSTALL_COMMAND)
    expect(terminalProps?.prepareCommandForShell?.(INSTALL_COMMAND, 'powershell.exe')).toMatch(
      /^& \{ \$PSNativeCommandArgumentPassing = 'Legacy'; wsl\.exe -d 'Ubuntu'/
    )
    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(mocks.clipboardWrite).toHaveBeenCalledWith(INSTALL_COMMAND)
  })

  it('shows a visible pending state while CLI setup preflight is running', async () => {
    let resolvePreflight: (() => void) | null = null
    const preflight = new Promise<void>((resolve) => {
      resolvePreflight = resolve
    })

    await renderInteractivePanel({
      onBeforeOpenTerminal: () => preflight
    })

    await clickButton('Install')

    expect(findButton('Preparing...').disabled).toBe(true)
    expect(container?.textContent).toContain('Preparing setup terminal.')
    expect(container?.textContent).not.toContain(INSTALL_COMMAND)

    await act(async () => {
      resolvePreflight?.()
      await preflight
    })
    await act(async () => {})

    expect(container?.textContent).toContain(INSTALL_COMMAND)
    expect(mocks.terminalProps.at(-1)).toMatchObject({ command: INSTALL_COMMAND })
  })

  it('opens installed setup with the installed command for preview, copy, and terminal', async () => {
    await renderInteractivePanel({ installed: true, installedCommand: UPDATE_COMMAND })

    await clickButton('Update')

    expect(container?.textContent).toContain(UPDATE_COMMAND)
    expect(mocks.terminalProps.at(-1)).toMatchObject({ command: UPDATE_COMMAND })

    await act(async () => {
      container
        ?.querySelector<HTMLButtonElement>('button[aria-label="Copy command"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.clipboardWrite).toHaveBeenCalledWith(UPDATE_COMMAND)
  })

  it('keeps an open terminal on the command captured when it opened', async () => {
    await renderInteractivePanel({ installed: false, installedCommand: UPDATE_COMMAND })
    await clickButton('Install')

    await rerenderInteractivePanel({ installed: true, installedCommand: UPDATE_COMMAND })

    expect(container?.textContent).toContain(INSTALL_COMMAND)
    expect(container?.textContent).not.toContain(UPDATE_COMMAND)
    expect(mocks.terminalProps.at(-1)).toMatchObject({ command: INSTALL_COMMAND })
  })

  it('keeps an open terminal on the WSL runtime captured when it opened', async () => {
    await renderInteractivePanel({
      terminalShellOverride: 'powershell.exe',
      terminalRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' }
    })
    await clickButton('Install')
    const openedCommand = mocks.terminalProps.at(-1)?.command
    const openedPrepareCommand = mocks.terminalProps.at(-1)?.prepareCommandForShell

    await rerenderInteractivePanel({
      terminalShellOverride: 'powershell.exe',
      terminalRuntime: { runtime: 'wsl', wslDistro: 'Fedora', label: 'WSL Fedora' }
    })

    expect(mocks.terminalProps.at(-1)?.command).toBe(openedCommand)
    expect(openedPrepareCommand?.(INSTALL_COMMAND, 'powershell.exe')).toContain(
      "wsl.exe -d 'Ubuntu'"
    )

    await rerenderInteractivePanel({
      terminalRuntime: { runtime: 'host', label: 'Windows' }
    })

    expect(mocks.terminalProps.at(-1)).toMatchObject({
      command: openedCommand,
      shellOverride: 'powershell.exe'
    })
  })

  it('captures the current runtime when retrying a failed command', async () => {
    await renderInteractivePanel({
      terminalShellOverride: 'powershell.exe',
      terminalRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' }
    })
    await clickButton('Install')
    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(1)
    })

    await rerenderInteractivePanel({
      terminalShellOverride: 'powershell.exe',
      terminalRuntime: { runtime: 'wsl', wslDistro: 'Fedora', label: 'WSL Fedora' }
    })
    expect(
      mocks.terminalProps.at(-1)?.prepareCommandForShell?.(INSTALL_COMMAND, 'powershell.exe')
    ).toContain("wsl.exe -d 'Ubuntu'")

    await clickButton('Retry')

    expect(
      mocks.terminalProps.at(-1)?.prepareCommandForShell?.(INSTALL_COMMAND, 'powershell.exe')
    ).toContain("wsl.exe -d 'Fedora'")

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(1)
    })
    await rerenderInteractivePanel({
      terminalShellOverride: 'powershell.exe',
      terminalRuntime: { runtime: 'host', label: 'Windows' }
    })

    await clickButton('Retry')

    const retryCommand = mocks.terminalProps
      .at(-1)
      ?.prepareCommandForShell?.(INSTALL_COMMAND, 'powershell.exe')
    expect(retryCommand).toMatch(/^cmd\.exe \/d \/s \/c /)
    expect(retryCommand).not.toContain('wsl.exe')
  })

  it('falls back to the install command for installed callers without installedCommand', async () => {
    await renderInteractivePanel({ installed: true })

    await clickButton('Update')

    expect(container?.textContent).toContain(INSTALL_COMMAND)
    expect(mocks.terminalProps.at(-1)).toMatchObject({ command: INSTALL_COMMAND })
  })

  it('keeps a failed setup command visible with durable recovery', async () => {
    const onRecheck = vi.fn()
    await renderInteractivePanel({ onRecheck })
    await clickButton('Install')
    onRecheck.mockClear()

    await act(async () => {
      const onCommandFinished = mocks.terminalProps.at(-1)?.onCommandFinished
      onCommandFinished?.(1)
      onCommandFinished?.(0)
    })

    expect(container?.textContent).toContain(
      'The setup command exited with code 1. This error will clear after a successful retry.'
    )
    expect(container?.textContent).toContain('Setup failed')
    expect(container?.querySelector('[data-testid="inline-command-terminal"]')).not.toBeNull()
    expect(findButton('Retry').disabled).toBe(false)
    expect(onRecheck).toHaveBeenCalledTimes(1)
  })

  it('clears the failure notice when a later command succeeds', async () => {
    await renderInteractivePanel()
    await clickButton('Install')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(1)
    })
    await clickButton('Retry')
    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(0)
    })

    expect(container?.textContent).not.toContain('exited with code')
  })

  it('keeps the failure verdict when a command finishes without an exit code', async () => {
    await renderInteractivePanel()
    await clickButton('Install')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(1)
    })
    await clickButton('Retry')
    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(null)
    })

    expect(container?.textContent).toContain(
      'The setup command exited with code 1. This error will clear after a successful retry.'
    )
  })

  it('retries a failed command in a fresh interactive terminal', async () => {
    let finishRetryPreflight: (() => void) | null = null
    const retryPreflight = new Promise<void>((resolve) => {
      finishRetryPreflight = resolve
    })
    let preflightCount = 0
    await renderInteractivePanel({
      onBeforeOpenTerminal: () => {
        preflightCount += 1
        return preflightCount === 1 ? undefined : retryPreflight
      }
    })
    await clickButton('Install')
    const firstInstance = container
      ?.querySelector('[data-testid="inline-command-terminal"]')
      ?.getAttribute('data-instance')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(1)
    })
    await clickButton('Retry')
    expect(container?.querySelector('[data-testid="inline-command-terminal"]')).toBeNull()

    await act(async () => {
      finishRetryPreflight?.()
      await retryPreflight
    })
    await act(async () => {})

    expect(mocks.terminalProps.at(-1)).toMatchObject({ command: INSTALL_COMMAND })
    expect(
      container
        ?.querySelector('[data-testid="inline-command-terminal"]')
        ?.getAttribute('data-instance')
    ).not.toBe(firstInstance)
    expect(findButton('Retry').disabled).toBe(true)
  })

  it('keeps the command failure authoritative over presence discovery', async () => {
    await renderInteractivePanel({ freshnessSkillName: 'orca-cli' })
    await clickButton('Install')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(1)
    })
    await rerenderInteractivePanel({ installed: true, freshnessSkillName: 'orca-cli' })

    expect(container?.textContent).toContain('Setup failed')
    expect(container?.textContent).toContain('exited with code 1')
    expect(container?.textContent).not.toContain('Installed')
    expect(container?.querySelector('[data-testid="skill-freshness"]')).toBeNull()
    expect(findButton('Retry').disabled).toBe(false)
  })

  it('keeps failed updates recoverable when installed re-check is hidden', async () => {
    await renderInteractivePanel({
      installed: true,
      installedCommand: UPDATE_COMMAND,
      showRecheckWhenInstalled: false
    })
    await clickButton('Update')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(1)
    })

    expect(container?.textContent).toContain('Setup failed')
    expect(container?.textContent).toContain('exited with code 1')
    expect(findButton('Retry').disabled).toBe(false)

    await clickButton('Retry')
    expect(mocks.terminalProps.at(-1)).toMatchObject({ command: UPDATE_COMMAND })
  })

  it('refreshes shared skill state after the direct completion re-check', async () => {
    const calls: string[] = []
    mocks.skillsRefreshed.mockImplementation(() => calls.push('presence'))
    mocks.freshnessRefresh.mockImplementation(async () => {
      calls.push('freshness')
    })
    const onRecheck = vi.fn(() => {
      calls.push('recheck')
    })
    await renderInteractivePanel({ freshnessSkillName: 'orca-cli', onRecheck })
    await clickButton('Install')
    calls.length = 0

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(0)
    })

    expect(calls).toEqual(['recheck', 'presence', 'freshness'])
  })

  it('rechecks once when command completion is followed by terminal exit', async () => {
    const onRecheck = vi.fn()
    await renderInteractivePanel({ freshnessSkillName: 'orca-cli', onRecheck })
    await clickButton('Install')

    await act(async () => {
      mocks.terminalProps.at(-1)?.onCommandFinished?.(0)
    })
    await act(async () => {
      mocks.terminalProps.at(-1)?.onTerminalExit?.()
    })
    await act(async () => {})

    expect(onRecheck).toHaveBeenCalledOnce()
    expect(mocks.skillsRefreshed).toHaveBeenCalledOnce()
    expect(mocks.freshnessRefresh).toHaveBeenCalledOnce()
  })

  it('re-enables Install after the setup shell exits so a failed attempt can retry', async () => {
    await renderInteractivePanel()
    await clickButton('Install')

    expect(findButton('Install').disabled).toBe(true)

    await act(async () => {
      mocks.terminalProps.at(-1)?.onTerminalExit?.()
    })

    expect(findButton('Install').disabled).toBe(false)
    expect(container?.querySelector('[data-testid="inline-command-terminal"]')).toBeNull()

    await clickButton('Install')

    expect(findButton('Install').disabled).toBe(true)
    expect(mocks.terminalProps.at(-1)).toMatchObject({ command: INSTALL_COMMAND })
  })
})
