// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getOrchestrationUsageExamples } from '@/lib/orchestration-usage-examples'
import { OrchestrationPane } from './OrchestrationPane'

const INSTALL_COMMAND =
  'npx skills add https://github.com/stablyai/orca --skill orchestration --global'
const UPDATE_COMMAND = 'npx skills update orchestration --global'

const mocks = vi.hoisted(() => ({
  dialogProps: [] as Record<string, unknown>[],
  panelProps: [] as Record<string, unknown>[],
  skillInstalled: true
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
        fileCount: 1,
        updatedAt: null
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

async function renderPane(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<OrchestrationPane />)
  })
  return container
}

describe('OrchestrationPane', () => {
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
  })

  it('keeps skill setup visible after install and shows agent coverage plus examples', () => {
    const markup = renderToStaticMarkup(<OrchestrationPane />)

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

  it('passes update commands to the main panel without an installed manual-copy path', async () => {
    const rendered = await renderPane()

    expect(mocks.panelProps.at(-1)).toEqual(
      expect.objectContaining({
        command: INSTALL_COMMAND,
        installedCommand: UPDATE_COMMAND
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
        command: INSTALL_COMMAND,
        open: true
      })
    )
    expect(rendered.textContent).toContain(INSTALL_COMMAND)
  })
})
