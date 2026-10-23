// @vitest-environment happy-dom

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BundledSkillInstallResult } from '../../../../shared/bundled-skill-plan'
import type { ProjectAgentSkillRuntime } from '@/lib/project-skill-runtime'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import { doneResult, planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { TooltipProvider } from '../ui/tooltip'
import { AgentSkillSetupPanel } from './AgentSkillSetupPanel'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const localTarget = (): BundledSkillTarget | null => ({ kind: 'local' })
  return {
    plan: vi.fn(),
    execute: vi.fn(),
    target: localTarget(),
    agentRuntime: ((): ProjectAgentSkillRuntime | undefined => undefined)(),
    installDisabledReason: ((): string | null => null)(),
    terminalShellOverride: ((): string | undefined => undefined)(),
    skillsChanged: vi.fn(),
    skillsRefreshed: vi.fn(),
    freshnessRefresh: vi.fn()
  }
})

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    bundledSkillTarget: mocks.target,
    agentRuntime: mocks.agentRuntime,
    installDisabledReason: mocks.installDisabledReason,
    terminalShellOverride: mocks.terminalShellOverride
  })
}))

vi.mock('@/hooks/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: mocks.skillsChanged
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  notifyInstalledAgentSkillsRefreshed: mocks.skillsRefreshed
}))

vi.mock('@/hooks/useSkillFreshness', () => ({
  refreshSkillFreshness: mocks.freshnessRefresh
}))

vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({
    command,
    shellOverride
  }: {
    command: string
    shellOverride?: string
  }) => (
    <pre data-testid="wsl-terminal" data-shell={shellOverride}>
      {command}
    </pre>
  )
}))

const WRITE_PLAN = planOf([sharedEntry('orca-cli', 'write')])

function panelProps(
  overrides: Partial<ComponentProps<typeof AgentSkillSetupPanel>> = {}
): ComponentProps<typeof AgentSkillSetupPanel> {
  return {
    title: 'CLI skill',
    description: 'Enables agents to use Orca workflows.',
    skillNames: ['orca-cli'],
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
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <AgentSkillSetupPanel {...panelProps(overrides)} />
      </TooltipProvider>
    )
  })
  await act(async () => {})
  return container
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
    mocks.plan.mockReset()
    mocks.plan.mockResolvedValue({ kind: 'plan', plan: WRITE_PLAN })
    mocks.execute.mockReset()
    mocks.execute.mockResolvedValue(doneResult(WRITE_PLAN))
    mocks.agentRuntime = undefined
    mocks.installDisabledReason = null
    mocks.terminalShellOverride = undefined
    mocks.target = { kind: 'local' }
    mocks.skillsChanged.mockReset()
    mocks.skillsRefreshed.mockReset()
    mocks.freshnessRefresh.mockReset()
    mocks.freshnessRefresh.mockResolvedValue(undefined)
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
  })

  it('offers Update once installed only when the plan would change something', async () => {
    mocks.plan.mockResolvedValue({
      kind: 'plan',
      plan: planOf([sharedEntry('orca-cli', 'update')])
    })
    await renderInteractivePanel({ installed: true })

    expect(container?.textContent).toContain('Update available')
    expect(findButton('Update')).toBeDefined()
    expect(findButton('Re-check')).toBeDefined()
  })

  it('shows only Re-check when the installed copy is already current', async () => {
    mocks.plan.mockResolvedValue({ kind: 'plan', plan: planOf([sharedEntry('orca-cli', 'keep')]) })
    await renderInteractivePanel({ installed: true })

    const labels = Array.from(container?.querySelectorAll('button') ?? [], (button) =>
      button.textContent?.trim()
    )
    expect(labels).toEqual(['Re-check'])
  })

  it('shows a checking verdict before the guided setup plan loads', () => {
    const html = renderPanel({
      installed: true,
      hideHeader: true,
      description: null,
      freshnessSkillName: 'orca-linear'
    })

    expect(html).toContain('Checking...')
    expect(html).not.toContain('CLI skill')
  })

  it('does not render an empty description paragraph when description is null', () => {
    const html = renderPanel({ description: null, hideHeader: true })

    expect(html).not.toContain('text-muted-foreground">null')
    expect(html).not.toMatch(/<p class="text-\[13px\] leading-snug text-muted-foreground"><\/p>/)
  })

  it('hides only re-check when installed re-checks are disabled', async () => {
    await renderInteractivePanel({ installed: true, showRecheckWhenInstalled: false })

    expect(findButton('Install')).toBeDefined()
    expect(container?.textContent).not.toContain('Re-check')
  })

  it('can hide install after the skill is detected', () => {
    const html = renderPanel({ installed: true, showInstallWhenInstalled: false })

    expect(html).toContain('Checking...')
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

  it('plans the named skills on the active host, runs that plan, and rechecks', async () => {
    const onRecheck = vi.fn(async () => {})
    await renderInteractivePanel({ onRecheck, freshnessSkillName: 'orca-cli' })

    await clickButton('Install')

    expect(mocks.plan).toHaveBeenCalledWith({ kind: 'local' }, { names: ['orca-cli'] })
    expect(mocks.execute).toHaveBeenCalledWith({ kind: 'local' }, WRITE_PLAN.planDigest, {
      names: ['orca-cli']
    })
    expect(container?.textContent).toContain('Installed')
    expect(mocks.skillsChanged).toHaveBeenCalledOnce()
    expect(onRecheck).toHaveBeenCalledOnce()
    expect(mocks.freshnessRefresh).toHaveBeenCalledOnce()
  })

  it('never installs on this machine for a paired host', async () => {
    mocks.target = { kind: 'environment', environmentId: 'env-1' }
    await renderInteractivePanel()

    await clickButton('Install')

    expect(mocks.plan).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      { names: ['orca-cli'] }
    )
  })

  it('shows progress while the install runs', async () => {
    let finish: ((value: BundledSkillInstallResult) => void) | null = null
    mocks.execute.mockReturnValue(
      new Promise<BundledSkillInstallResult>((resolve) => {
        finish = resolve
      })
    )
    await renderInteractivePanel()

    await clickButton('Install')
    expect(findButton('Installing...').disabled).toBe(true)

    await act(async () => {
      finish?.(doneResult(WRITE_PLAN))
    })
    expect(findButton('Install').disabled).toBe(false)
  })

  it('updates the installed name when it differs from the install name', async () => {
    const plan = planOf([sharedEntry('linear-tickets', 'update')])
    mocks.plan.mockResolvedValue({ kind: 'plan', plan })
    mocks.execute.mockResolvedValue(doneResult(plan))
    await renderInteractivePanel({
      installed: true,
      skillNames: ['orca-linear'],
      installedSkillNames: ['linear-tickets']
    })

    await clickButton('Update')

    expect(mocks.plan).toHaveBeenCalledWith({ kind: 'local' }, { names: ['linear-tickets'] })
  })

  it('offers Replace for an edited copy and replaces only that path', async () => {
    const edited = planOf([
      sharedEntry('orca-cli', 'leave', { reason: 'edited', replaceable: true })
    ])
    const replaced = planOf([sharedEntry('orca-cli', 'replace')])
    mocks.plan.mockResolvedValue({ kind: 'plan', plan: edited })
    await renderInteractivePanel({ installed: true })
    expect(container?.textContent).not.toContain('Update')

    mocks.plan.mockResolvedValue({ kind: 'plan', plan: replaced })
    mocks.execute.mockResolvedValueOnce(doneResult(replaced))
    await clickButton("Replace with Orca's copy")

    const path = '/home/u/.agents/skills/orca-cli'
    expect(mocks.plan).toHaveBeenCalledWith(
      { kind: 'local' },
      { names: ['orca-cli'], force: [path] }
    )
    expect(mocks.execute).toHaveBeenCalledWith({ kind: 'local' }, replaced.planDigest, {
      names: ['orca-cli'],
      force: [path]
    })
    expect(container?.textContent).toContain('Replaced · Your copy was saved as a backup')
  })

  it('says why an edited copy was left alone, without calling it a failure', async () => {
    const plan = planOf([sharedEntry('orca-cli', 'leave', { reason: 'edited', replaceable: true })])
    mocks.plan.mockResolvedValue({ kind: 'plan', plan })
    mocks.execute.mockResolvedValueOnce(doneResult(plan))
    await renderInteractivePanel()

    await clickButton("Replace with Orca's copy")

    expect(container?.textContent).toContain(
      'Installed · Update skipped in Shared folder: Skill edited outside Orca'
    )
    expect(container?.textContent).not.toContain('Needs attention')
  })

  it('reports a run that found the disk changed as needing attention, and retries it', async () => {
    mocks.execute.mockResolvedValueOnce({
      scope: 'global',
      skills: [{ name: 'orca-cli', status: 'changed', ops: [] }]
    })
    await renderInteractivePanel()

    await clickButton('Install')

    expect(container?.textContent).toContain('Needs attention')
    await clickButton('Retry')
    expect(mocks.execute).toHaveBeenCalledTimes(2)
    expect(container?.textContent).not.toContain('Needs attention')
  })

  it('reports a known thrown install error in plain words', async () => {
    await renderInteractivePanel()
    mocks.plan.mockRejectedValue(
      new Error(
        "Error invoking remote method 'skills:bundledPlan': Error: skill-install-wsl-unavailable"
      )
    )

    await clickButton('Install')

    expect(container?.textContent).toContain(
      'WSL is not available on this machine, so Orca could not install the skills there.'
    )
    expect(container?.textContent).not.toContain('Error invoking remote method')
  })

  it('names an unknown install error code after the plain failure', async () => {
    mocks.execute.mockRejectedValueOnce(new Error('skill-install-journal-invalid'))
    await renderInteractivePanel()

    await clickButton('Install')

    expect(container?.textContent).toContain(
      'Orca could not install the skills. (skill-install-journal-invalid)'
    )
  })

  it('shows Retry in place of Install after a failure', async () => {
    mocks.execute.mockRejectedValue(new Error('skill-install-home-unavailable'))
    await renderInteractivePanel()

    await clickButton('Install')

    const labels = Array.from(container?.querySelectorAll('button') ?? [], (button) =>
      button.textContent?.trim()
    )
    expect(labels).toContain('Retry')
    expect(labels).not.toContain('Install')
  })

  it('keeps each host its own result', async () => {
    mocks.execute.mockRejectedValue(new Error('skill-install-home-unavailable'))
    await renderInteractivePanel()
    await clickButton('Install')
    expect(container?.textContent).toContain('Needs attention')

    mocks.target = { kind: 'environment', environmentId: 'env-2' }
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <AgentSkillSetupPanel {...panelProps()} />
        </TooltipProvider>
      )
    })
    expect(container?.textContent).not.toContain('Needs attention')
    expect(findButton('Install').disabled).toBe(false)

    mocks.target = { kind: 'local' }
    await act(async () => {
      root?.render(
        <TooltipProvider>
          <AgentSkillSetupPanel {...panelProps()} />
        </TooltipProvider>
      )
    })
    expect(container?.textContent).toContain('Needs attention')
  })

  it('keeps Install disabled while the host that runs the agents is unknown', async () => {
    mocks.target = null
    await renderInteractivePanel()

    expect(findButton('Install').disabled).toBe(true)
    expect(container?.textContent).toContain(
      "Orca can't install skills on this workspace's machine yet."
    )
  })

  it('does not install when the caller cancels before install', async () => {
    await renderInteractivePanel({
      onBeforeInstall: async () => {
        throw new Error('cancelled')
      }
    })

    await clickButton('Install')

    expect(mocks.execute).not.toHaveBeenCalled()
    expect(mocks.plan).toHaveBeenCalledTimes(1)
  })

  it('installs for an SSH workspace once its managed server is the target', async () => {
    mocks.target = { kind: 'environment', environmentId: 'managed-ssh' }
    await renderInteractivePanel()

    await clickButton('Install')

    expect(mocks.plan).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'managed-ssh' },
      { names: ['orca-cli'] }
    )
  })

  it('asks to connect an SSH host no server serves yet, writing nothing here', async () => {
    mocks.target = { kind: 'ssh', targetId: 'box' }
    mocks.plan.mockResolvedValue({ kind: 'unsupported', reason: 'connect-host' })
    await renderInteractivePanel()

    expect(container?.textContent).toContain('Connect to this SSH host to install its skills.')
    expect(buttonLabels(container?.innerHTML ?? '')).not.toContain('Install')
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('plans and installs on an explicit surface target even when the active project is WSL', async () => {
    mocks.target = null
    mocks.agentRuntime = { runtime: 'wsl', wslDistro: 'Debian', label: 'WSL Debian' }
    const target = { kind: 'environment', environmentId: 'selected-host' } as const
    await renderInteractivePanel({ target, installed: true })
    expect(mocks.plan).toHaveBeenCalledWith(target, { names: ['orca-cli'] })
    await clickButton('Install')
    expect(mocks.execute).toHaveBeenCalledWith(target, WRITE_PLAN.planDigest, {
      names: ['orca-cli']
    })
    expect(container?.querySelector('[data-testid="wsl-terminal"]')).toBeNull()
  })

  it('does not infer WSL from an explicitly unresolved surface target', async () => {
    mocks.agentRuntime = { runtime: 'wsl', wslDistro: 'Debian', label: 'WSL Debian' }
    await renderInteractivePanel({ target: null })
    expect(findButton('Install').disabled).toBe(true)
    expect(mocks.plan).not.toHaveBeenCalled()
  })

  it('keeps the main npx command in a legacy WSL terminal without invoking the bundled installer', async () => {
    mocks.target = null
    mocks.agentRuntime = { runtime: 'wsl', wslDistro: 'Debian', label: 'WSL Debian' }
    await renderInteractivePanel()
    await clickButton('Install')
    expect(container?.querySelector('[data-testid="wsl-terminal"]')?.textContent).toBe(
      `npx skills@1.7.2 add https://github.com/stablyai/orca/tree/${'0'.repeat(40)} --skill orca-cli --global`
    )
    expect(mocks.plan).not.toHaveBeenCalled()
    expect(mocks.execute).not.toHaveBeenCalled()
  })

  it('uses the selected WSL runtime and shell even when another project needs repair', async () => {
    mocks.target = null
    mocks.agentRuntime = { runtime: 'wsl', wslDistro: 'Debian', label: 'WSL Debian' }
    mocks.installDisabledReason = 'Debian is missing'
    mocks.terminalShellOverride = 'wsl.exe'
    await renderInteractivePanel({
      target: null,
      terminalRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' }
    })
    expect(findButton('Install').disabled).toBe(false)
    await clickButton('Install')
    expect(
      container?.querySelector('[data-testid="wsl-terminal"]')?.getAttribute('data-shell')
    ).toBe('powershell.exe')
    expect(mocks.plan).not.toHaveBeenCalled()
  })

  it('keeps the repair gate when setup targets the active project', async () => {
    mocks.target = null
    mocks.agentRuntime = { runtime: 'wsl', wslDistro: 'Debian', label: 'WSL Debian' }
    mocks.installDisabledReason = 'Debian is missing'
    await renderInteractivePanel()
    expect(findButton('Install').disabled).toBe(true)
  })

  it('honors the selected WSL surface disabled state', async () => {
    await renderInteractivePanel({
      target: null,
      terminalRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' },
      installDisabled: true
    })
    expect(findButton('Install').disabled).toBe(true)
  })

  it('asks for a newer Orca on a server without the installer, writing nothing here', async () => {
    mocks.plan.mockResolvedValue({ kind: 'unsupported', reason: 'update-server' })
    mocks.target = { kind: 'environment', environmentId: 'old' }
    const onRecheck = vi.fn(async () => {})
    await renderInteractivePanel({ onRecheck })

    expect(container?.textContent).toContain('Update Orca on the server to install its skills.')
    expect(buttonLabels(container?.innerHTML ?? '')).not.toContain('Install')
    expect(mocks.execute).not.toHaveBeenCalled()
    expect(onRecheck).not.toHaveBeenCalled()
  })
})
