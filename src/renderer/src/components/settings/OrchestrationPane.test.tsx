// @vitest-environment happy-dom

import { act } from 'react'
import type { AgentSkillSetupPanelProps } from './agent-skill-setup-panel-props'
import { planEntry, planOf, planOp } from '../skills/bundled-skill-plan-fixtures.test-support'
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

const mocks = vi.hoisted(() => ({
  panelProps: [] as Record<string, unknown>[],
  skillInstalled: true,
  updateSettings: vi.fn()
}))

vi.mock('./AgentSkillSetupPanel', () => ({
  AgentSkillSetupPanel: (props: AgentSkillSetupPanelProps) => {
    mocks.panelProps.push({ ...props })
    return (
      <section>
        <h3>{String(props.title)}</h3>
        <span>{props.installed ? 'Installed' : 'Not installed'}</span>
        <button type="button">{props.installed ? 'Update' : 'Install'}</button>
        <button type="button">Re-check</button>
        {props.actionHint}
        {typeof props.footer === 'function'
          ? props.footer(
              planOf([
                planEntry('orchestration', [
                  planOp('keep', '/home/u/.claude/skills/orchestration', {
                    observed: { kind: 'link', target: '/home/u/.agents/skills/orchestration' }
                  }),
                  planOp('write', '/home/u/.agents/skills/orchestration', { agents: ['codex'] }),
                  planOp('link', '/home/u/.gemini/skills/orchestration', { agents: ['gemini'] })
                ])
              ])
            )
          : props.footer}
      </section>
    )
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
        sourceLabel: 'Claude Code home',
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
        label: 'Claude Code home',
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

  it('installs the orchestration skill, which also updates, with no manual-copy path', async () => {
    mocks.skillInstalled = false
    const rendered = await renderPane()

    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({ skillNames: ['orchestration'] })
    )
    expect(mocks.panelProps.at(-1)?.installedSkillNames).toBeUndefined()
    expect(rendered.textContent).not.toContain('Prefer your own terminal?')
    expect(rendered.textContent).not.toContain('Copy install command')
  })
})
