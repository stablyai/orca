// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOrchestrationUsageExamples } from '@/lib/orchestration-usage-examples'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { useAppStore } from '../../store'
import { OrchestrationPane } from './OrchestrationPane'
import { getOrchestrationPaneSearchEntries } from './orchestration-search'
import { matchesSettingsSearch } from './settings-search'

const INSTALL_COMMAND =
  'npx skills add https://github.com/stablyai/orca --skill orchestration --global'
const UPDATE_COMMAND = INSTALL_COMMAND
const WINDOWS_INSTALL_COMMAND =
  'cmd.exe /d /s /c "where.exe npx >nul 2>nul & if errorlevel 1 (echo ERROR: npx was not found. Install Node.js LTS from https://nodejs.org/ to get npx. & echo Then close this terminal and start skill setup again - a new terminal picks up the updated PATH. & exit /b 1) else (npx skills add https://github.com/stablyai/orca --skill orchestration --global)"'

const mocks = vi.hoisted(() => ({
  dialogProps: [] as Record<string, unknown>[],
  panelProps: [] as Record<string, unknown>[],
  skillInstalled: true,
  updateSettings: vi.fn()
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (
    props: Record<string, unknown> & { actionHint?: ReactNode; footer?: ReactNode }
  ) => {
    mocks.panelProps.push(props)
    return (
      <section>
        <h3>{String(props.title)}</h3>
        <span>{props.installed ? 'Installed' : 'Not installed'}</span>
        <code>{String(props.command)}</code>
        <code>{String(props.installedCommand)}</code>
        <button type="button">{props.installed ? 'Update' : 'Install'}</button>
        <button type="button">Re-check</button>
        {props.actionHint}
        {props.footer}
      </section>
    )
  }
}))

vi.mock('./OrchestrationSkillPromptDialog', () => ({
  OrchestrationSkillPromptDialog: (props: Record<string, unknown>) => {
    mocks.dialogProps.push(props)
    return props.open ? (
      <div data-testid="orchestration-skill-prompt-dialog">
        <code>{String(props.command)}</code>
      </div>
    ) : null
  }
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkill: () => ({
    installed: mocks.skillInstalled,
    loading: false,
    error: null,
    skills: [
      {
        id: 'claude',
        name: 'orchestration',
        description: null,
        providers: ['claude'],
        sourceKind: 'home',
        sourceLabel: 'Claude home',
        rootPath: '/Users/test/.claude/skills',
        directoryPath: '/Users/test/.claude/skills/orchestration',
        skillFilePath: '/Users/test/.claude/skills/orchestration/SKILL.md',
        installed: true,
        updatedAt: null
      }
    ],
    sources: [
      {
        id: 'home-claude',
        label: 'Claude home',
        path: '/Users/test/.claude/skills',
        sourceKind: 'home',
        providers: ['claude'],
        owner: 'claude',
        exists: true
      }
    ],
    refresh: vi.fn()
  })
}))

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'codex', 'gemini'],
    isLoading: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function setNativeValue(input: HTMLInputElement, text: string): void {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setValue?.call(input, text)
}

function getPaneProps(settings: GlobalSettings = getDefaultSettings('/tmp')) {
  return { settings, updateSettings: mocks.updateSettings }
}

async function renderPane(
  settings: GlobalSettings = getDefaultSettings('/tmp')
): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<OrchestrationPane {...getPaneProps(settings)} />)
  })
  return container
}

describe('OrchestrationPane', () => {
  beforeEach(() => {
    useAppStore.setState({ settingsSearchQuery: '' })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        platform: {
          get: () => ({ platform: 'win32', osRelease: 'test' })
        },
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: {
          isAvailable: vi.fn().mockResolvedValue(false)
        },
        gitBash: {
          isAvailable: vi.fn().mockResolvedValue(false)
        },
        runtime: {
          getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' })
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
    mocks.dialogProps.length = 0
    mocks.panelProps.length = 0
    mocks.skillInstalled = true
    mocks.updateSettings.mockReset()
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
  })

  it('keeps skill setup visible after install and shows agent coverage plus examples', () => {
    const markup = renderToStaticMarkup(<OrchestrationPane {...getPaneProps()} />)

    expect(markup).toContain('Orchestration skill')
    expect(markup).toContain('Installed')
    expect(markup).toContain('Agent coverage')
    expect(markup).not.toContain('Prefer your own terminal?')
    expect(markup).not.toContain('Copy update command')
    expect(markup).toContain('detected agents')
    expect(markup).toContain('Gemini')
    expect(markup).toContain('Ready')
    expect(markup).toContain('How to use it')
    expect(markup).not.toContain('See examples')
    const examples = getOrchestrationUsageExamples()
    expect(examples).toHaveLength(5)
    for (const example of examples) {
      expect(markup).toContain(example.title)
    }
    expect(markup).toMatch(/<button\b[^>]*>[\s\S]*?Update[\s\S]*?<\/button>/)
    expect(markup).toContain('Re-check')
  })

  it('renders nested worker depth as an unbounded positive whole-number input', () => {
    const markup = renderToStaticMarkup(<OrchestrationPane {...getPaneProps()} />)

    expect(markup).toContain('Nested worker depth')
    expect(markup).toContain('type="number"')
    expect(markup).toContain('aria-label="Nested worker depth"')
    expect(markup).toContain('min="1"')
    expect(markup).not.toContain('max=')
    expect(markup).not.toContain('Default:')
    expect(markup.indexOf('Nested worker depth')).toBeGreaterThan(
      markup.indexOf('Orchestration skill')
    )
    expect(matchesSettingsSearch('nested worker', getOrchestrationPaneSearchEntries())).toBe(true)
  })

  it('keeps the nested depth row visible when settings search routes to Orchestration', () => {
    useAppStore.setState({ settingsSearchQuery: 'Nested worker' })

    const markup = renderToStaticMarkup(<OrchestrationPane {...getPaneProps()} />)

    expect(markup).toContain('Nested worker depth')
    expect(markup).toContain('aria-label="Nested worker depth"')
  })

  it('commits a whole-number depth and rejects fractional values', async () => {
    const rendered = await renderPane()
    const input = rendered.querySelector<HTMLInputElement>(
      'input[aria-label="Nested worker depth"]'
    )
    if (!input) {
      throw new Error('Nested worker depth input was not rendered')
    }

    await act(async () => {
      setNativeValue(input, '5')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(mocks.updateSettings).toHaveBeenCalledWith({ nestedWorkerMaxDepth: 5 })

    mocks.updateSettings.mockClear()
    await act(async () => {
      setNativeValue(input, '2.5')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(mocks.updateSettings).not.toHaveBeenCalled()
    expect(input.value).toBe('1')
  })

  it('keeps host-only nested depth out of paired web clients', () => {
    ;(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ = true
    const markup = renderToStaticMarkup(<OrchestrationPane {...getPaneProps()} />)

    expect(markup).not.toContain('Nested worker depth')
    expect(
      matchesSettingsSearch(
        'nested worker',
        getOrchestrationPaneSearchEntries({ includeNestedWorkerDepth: false })
      )
    ).toBe(false)
  })

  it('passes update commands to the main panel without an installed manual-copy path', async () => {
    const rendered = await renderPane()

    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({
        command: WINDOWS_INSTALL_COMMAND,
        installedCommand: WINDOWS_INSTALL_COMMAND
      })
    )

    expect(rendered.textContent).not.toContain('Prefer your own terminal?')
    expect(rendered.textContent).not.toContain('Copy update command')
    expect(rendered.textContent).not.toContain('Copy install command')
    expect(mocks.dialogProps).not.toContainEqual(expect.objectContaining({ mode: 'update' }))
    expect(mocks.dialogProps).not.toContainEqual(
      expect.objectContaining({
        command: UPDATE_COMMAND,
        open: true
      })
    )
  })

  it('keeps first-time manual copy on the install command', async () => {
    mocks.skillInstalled = false
    const rendered = await renderPane()

    expect(rendered.textContent).toContain('Prefer your own terminal?')
    expect(rendered.textContent).toContain('Copy install command')
    expect(rendered.textContent).not.toContain('Copy update command')

    const copyButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Copy install command'
    )
    expect(copyButton).toBeDefined()

    await act(async () => {
      copyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(mocks.dialogProps.at(-1)).toEqual(
      expect.objectContaining({
        command: WINDOWS_INSTALL_COMMAND,
        open: true
      })
    )
    expect(rendered.textContent).toContain(WINDOWS_INSTALL_COMMAND)
  })
})
