// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'
import { TooltipProvider } from '../ui/tooltip'

const INSTALL_COMMAND = 'npx skills add https://github.com/stablyai/orca --skill orca-cli --global'
const UPDATE_COMMAND = 'npx skills update orca-cli --global'

const mocks = vi.hoisted(() => ({
  clipboardWrite: vi.fn(),
  terminalProps: [] as { command: string; description: string }[],
  toastError: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: mocks.toastSuccess
  }
}))

vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: (props: { command: string; description: string }) => {
    mocks.terminalProps.push(props)
    return (
      <div
        data-testid="inline-command-terminal"
        data-command={props.command}
        data-description={props.description}
      >
        {props.command}
      </div>
    )
  }
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
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        cli: {
          getInstallStatus: vi.fn()
        },
        ui: {
          writeClipboardText: mocks.clipboardWrite
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

  it('falls back to the install command for installed callers without installedCommand', async () => {
    await renderInteractivePanel({ installed: true })

    await clickButton('Update')

    expect(container?.textContent).toContain(INSTALL_COMMAND)
    expect(mocks.terminalProps.at(-1)).toMatchObject({ command: INSTALL_COMMAND })
  })
})
