// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContextReport } from '../../../../shared/agent-context'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../../shared/skills'
import {
  agentsInContext,
  filterReportByAgents,
  filterReportByScope,
  groupInstructionFiles,
  selectSkillsForAgents,
  selectSkillsForScope,
  selectWorkspaceSkills
} from './workspace-context-model'

const testState = vi.hoisted(() => ({
  worktree: null as null | { id: string; path: string; branch: string },
  context: {
    report: null as AgentContextReport | null,
    loading: false,
    error: null as string | null,
    skills: [] as DiscoveredSkill[],
    skillSources: [] as SkillDiscoverySource[],
    skillsLoading: false,
    refresh: () => {}
  },
  openFile: [] as { filePath: string; relativePath: string }[]
}))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: { openFile: (file: unknown) => void }) => T): T =>
    selector({
      openFile: (file) => {
        testState.openFile.push(file as { filePath: string; relativePath: string })
      }
    })
}))
vi.mock('@/store/selectors', () => ({ useActiveWorktree: () => testState.worktree }))
vi.mock('./use-workspace-agent-context', () => ({
  useWorkspaceAgentContext: () => ({
    worktreeId: testState.worktree?.id ?? null,
    worktreePath: testState.worktree?.path ?? null,
    ...testState.context
  })
}))
// Why: Radix menus and toggle groups need pointer/layout APIs happy-dom lacks;
// the panel test drives the same props through plain controls.
vi.mock('./workspace-context-controls', () => ({
  ContextScopeSwitch: ({
    scope,
    onScopeChange
  }: {
    scope: string
    onScopeChange: (scope: 'workspace' | 'user' | 'all') => void
  }) => (
    <select
      data-testid="scope"
      value={scope}
      onChange={(event) => onScopeChange(event.target.value as 'workspace' | 'user' | 'all')}
    >
      <option value="workspace">Workspace</option>
      <option value="user">User</option>
      <option value="all">All</option>
    </select>
  ),
  ContextViewMenu: ({
    agentOptions,
    agents,
    showMissing,
    onAgentEnabledChange,
    onAllAgentsEnabledChange,
    onShowMissingChange
  }: {
    agentOptions: readonly string[]
    agents: readonly string[] | null
    showMissing: boolean
    onAgentEnabledChange: (agent: string, enabled: boolean) => void
    onAllAgentsEnabledChange: (enabled: boolean) => void
    onShowMissingChange: (showMissing: boolean) => void
  }) => (
    <div data-testid="view-menu">
      {agentOptions.map((agent) => (
        <button
          key={agent}
          type="button"
          data-testid={`agent-${agent}`}
          aria-pressed={agents === null || agents.includes(agent)}
          onClick={() => onAgentEnabledChange(agent, !(agents === null || agents.includes(agent)))}
        >
          {agent}
        </button>
      ))}
      <button
        type="button"
        data-testid="agents-clear"
        onClick={() => onAllAgentsEnabledChange(false)}
      >
        clear
      </button>
      <button
        type="button"
        data-testid="show-missing"
        aria-pressed={showMissing}
        onClick={() => onShowMissingChange(!showMissing)}
      >
        missing
      </button>
    </div>
  )
}))
vi.mock('@/lib/agent-catalog', () => ({
  AGENT_CATALOG: ['claude', 'codex', 'gemini', 'grok'].map((id) => ({ id, label: id }))
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values ? fallback.replace('{{value0}}', String(values.value0)) : fallback
}))

import WorkspaceContextPanel from './WorkspaceContextPanel'

function report(overrides: Partial<AgentContextReport> = {}): AgentContextReport {
  return {
    target: { kind: 'native-host', homeDir: '/home/u', cwd: '/home/u/repo' },
    instructionFiles: [
      {
        id: 'home-claude-md',
        label: 'CLAUDE.md',
        path: '/home/u/.claude/CLAUDE.md',
        scope: 'home',
        agents: ['claude'],
        exists: true,
        sizeBytes: 120,
        updatedAt: 1
      },
      {
        id: 'project-claude-md',
        label: 'CLAUDE.md',
        path: '/home/u/repo/CLAUDE.md',
        scope: 'project',
        agents: ['claude'],
        exists: true,
        sizeBytes: 2048,
        updatedAt: 1
      },
      {
        id: 'project-gemini-md',
        label: 'GEMINI.md',
        path: '/home/u/repo/GEMINI.md',
        scope: 'project',
        agents: ['gemini'],
        exists: false,
        sizeBytes: null,
        updatedAt: null
      }
    ],
    mcpFiles: [
      {
        id: 'project-mcp:.mcp.json',
        path: '/home/u/repo/.mcp.json',
        scope: 'project',
        agents: ['claude'],
        inspection: {
          candidate: {
            format: 'workspace',
            label: 'Workspace',
            relativePath: '.mcp.json',
            serversPath: ['mcpServers']
          },
          exists: true,
          status: 'valid',
          servers: [{ name: 'linear', transport: 'stdio', status: 'enabled', command: 'npx' }]
        }
      }
    ],
    hookFiles: [],
    plugins: [
      {
        id: 'p1',
        name: 'adhd@local',
        agents: ['claude'],
        enabled: true,
        sourcePath: '/home/u/.claude/settings.json',
        scope: 'home'
      }
    ],
    scannedAt: 1,
    ...overrides
  }
}

describe('WorkspaceContextPanel', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    testState.worktree = { id: 'wt-1', path: '/home/u/repo', branch: 'main' }
    testState.context.report = report()
    testState.openFile = []
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('lists present instruction files and hides missing ones by default', () => {
    act(() => root.render(<WorkspaceContextPanel />))
    const text = container.textContent ?? ''
    expect(text).toContain('/home/u/repo/CLAUDE.md')
    expect(text).toContain('2.0 KB')
    expect(text).not.toContain('GEMINI.md')
    expect(text).toContain('linear')
    expect(text).toContain('Agent context')
  })

  it('reveals checked-but-empty locations when toggled', () => {
    act(() => root.render(<WorkspaceContextPanel />))
    const toggle = container.querySelector('[data-testid="show-missing"]') as HTMLButtonElement
    act(() => {
      toggle.click()
    })
    expect(container.textContent).toContain('GEMINI.md')
    expect(container.textContent).toContain('not found')
  })

  it('opens a workspace-scoped instruction file in the editor on click', () => {
    act(() => root.render(<WorkspaceContextPanel />))
    const button = [...container.querySelectorAll('button')].find((el) =>
      el.textContent?.includes('/home/u/repo/CLAUDE.md')
    )
    expect(button).toBeDefined()
    act(() => button?.click())
    expect(testState.openFile).toEqual([
      expect.objectContaining({ relativePath: 'CLAUDE.md', filePath: '/home/u/repo/CLAUDE.md' })
    ])
  })

  it('filters to one section from the filter strip', () => {
    act(() => root.render(<WorkspaceContextPanel />))
    const mcpTab = [...container.querySelectorAll('[role="radio"]')].find(
      (el) => el.textContent === 'MCP'
    ) as HTMLButtonElement
    act(() => mcpTab.click())
    const text = container.textContent ?? ''
    expect(text).toContain('linear')
    expect(text).not.toContain('/home/u/repo/CLAUDE.md')
    expect(text).not.toContain('adhd@local')
  })

  it('offers only agents present in the workspace and narrows every section to the chosen one', () => {
    act(() => root.render(<WorkspaceContextPanel />))
    const menu = container.querySelector('[data-testid="view-menu"]') as HTMLElement
    expect(
      [...menu.querySelectorAll('[data-testid^="agent-"]')].map((el) => el.textContent)
    ).toEqual(['claude', 'gemini'])
    act(() => (menu.querySelector('[data-testid="agent-claude"]') as HTMLButtonElement).click())
    act(() => (menu.querySelector('[data-testid="show-missing"]') as HTMLButtonElement).click())
    const text = container.textContent ?? ''
    expect(text).toContain('GEMINI.md')
    expect(text).not.toContain('/home/u/repo/CLAUDE.md')
    expect(text).not.toContain('linear')
    expect(text).not.toContain('adhd@local')
  })

  it('narrows to workspace-scoped rows with the scope switch', () => {
    act(() => root.render(<WorkspaceContextPanel />))
    const select = container.querySelector('[data-testid="scope"]') as HTMLSelectElement
    act(() => {
      select.value = 'workspace'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const text = container.textContent ?? ''
    expect(text).toContain('/home/u/repo/CLAUDE.md')
    expect(text).not.toContain('/home/u/.claude/CLAUDE.md')
    expect(text).not.toContain('adhd@local')
    act(() => {
      select.value = 'user'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.textContent).toContain('/home/u/.claude/CLAUDE.md')
    expect(container.textContent).not.toContain('linear')
  })

  it('shows the empty state without an active worktree', () => {
    testState.worktree = null
    act(() => root.render(<WorkspaceContextPanel />))
    expect(container.textContent).toContain('Select a workspace')
  })
})

describe('workspace-context-model', () => {
  it('keeps global skills and only repo skills rooted in the workspace', () => {
    const skill = (id: string, sourceKind: DiscoveredSkill['sourceKind'], rootPath: string) =>
      ({
        id,
        name: id,
        description: null,
        providers: ['claude'],
        sourceKind,
        sourceLabel: '',
        rootPath,
        directoryPath: rootPath,
        skillFilePath: `${rootPath}/SKILL.md`,
        installed: true,
        updatedAt: null
      }) satisfies DiscoveredSkill
    const selected = selectWorkspaceSkills(
      [
        skill('home', 'home', '/home/u/.claude/skills'),
        skill('mine', 'repo', '/home/u/repo/.claude/skills'),
        skill('other', 'repo', '/home/u/other-repo/.claude/skills'),
        skill('win', 'repo', 'C:\\Users\\u\\Repo\\.claude\\skills')
      ],
      '/home/u/repo'
    )
    expect(selected.map((entry) => entry.id)).toEqual(['home', 'mine'])
    expect(
      selectWorkspaceSkills(
        [skill('win', 'repo', 'C:\\Users\\u\\Repo\\.claude\\skills')],
        'c:/users/u/repo'
      ).map((entry) => entry.id)
    ).toEqual(['win'])
  })

  it('groups instruction files by scope, project first, dropping missing unless asked', () => {
    const files = report().instructionFiles
    expect(
      groupInstructionFiles(files, false).map((group) => [group.scope, group.files.length])
    ).toEqual([
      ['project', 1],
      ['home', 1]
    ])
    expect(groupInstructionFiles(files, true).map((group) => group.files.length)).toEqual([2, 1])
  })

  it('narrows the report and skills to the chosen agents', () => {
    const full = report()
    const claude = filterReportByAgents(full, ['claude'])
    expect(claude?.instructionFiles.map((file) => file.id)).toEqual([
      'home-claude-md',
      'project-claude-md'
    ])
    expect(claude?.mcpFiles).toHaveLength(1)
    const gemini = filterReportByAgents(full, ['gemini'])
    expect(gemini?.instructionFiles.map((file) => file.id)).toEqual(['project-gemini-md'])
    expect(gemini?.mcpFiles).toHaveLength(0)
    expect(gemini?.plugins).toHaveLength(0)
    expect(filterReportByAgents(full, null)).toBe(full)
    expect(filterReportByAgents(full, ['claude', 'gemini'])?.instructionFiles).toHaveLength(3)
    expect(filterReportByAgents(full, [])?.instructionFiles).toHaveLength(0)

    const sources: SkillDiscoverySource[] = [
      {
        id: 'a',
        label: 'Agent skills home',
        path: '/h/.agents/skills',
        sourceKind: 'home',
        providers: ['agent-skills'],
        owner: null,
        exists: true
      },
      {
        id: 'g',
        label: 'Grok home',
        path: '/h/.grok/skills',
        sourceKind: 'home',
        providers: ['agent-skills'],
        owner: 'grok',
        exists: true
      },
      {
        id: 'c',
        label: 'Claude home',
        path: '/h/.claude/skills',
        sourceKind: 'home',
        providers: ['claude'],
        owner: 'claude',
        exists: true
      }
    ]
    const skill = (id: string, rootPath: string, providers: DiscoveredSkill['providers']) =>
      ({
        id,
        name: id,
        description: null,
        providers,
        sourceKind: 'home',
        sourceLabel: '',
        rootPath,
        directoryPath: rootPath,
        skillFilePath: `${rootPath}/${id}/SKILL.md`,
        installed: true,
        updatedAt: null
      }) satisfies DiscoveredSkill
    const skills = [
      skill('shared', '/h/.agents/skills', ['agent-skills']),
      skill('grok-only', '/h/.grok/skills', ['agent-skills']),
      skill('claude-only', '/h/.claude/skills', ['claude']),
      skill('plugin', '/h/.claude/plugins/cache/x', ['claude'])
    ]
    expect(selectSkillsForAgents(skills, sources, ['grok']).map((entry) => entry.id)).toEqual([
      'shared',
      'grok-only'
    ])
    expect(selectSkillsForAgents(skills, sources, ['claude']).map((entry) => entry.id)).toEqual([
      'shared',
      'claude-only',
      'plugin'
    ])
    expect(agentsInContext(full, skills, sources).sort()).toEqual(
      ['claude', 'gemini', 'grok'].sort()
    )
    expect(selectSkillsForScope(skills, 'user').map((entry) => entry.id)).toEqual(
      skills.map((entry) => entry.id)
    )
    expect(selectSkillsForScope(skills, 'workspace')).toEqual([])
  })

  it('splits the report between the workspace tree and the user home', () => {
    const full = report()
    const workspace = filterReportByScope(full, 'workspace')
    expect(workspace?.instructionFiles.length).toBeGreaterThan(0)
    expect(workspace?.instructionFiles.every((file) => file.scope !== 'home')).toBe(true)
    expect(workspace?.plugins).toHaveLength(0)
    const user = filterReportByScope(full, 'user')
    expect(user?.instructionFiles.map((file) => file.id)).toEqual(['home-claude-md'])
    expect(user?.mcpFiles).toHaveLength(0)
    expect(filterReportByScope(full, 'all')).toBe(full)
  })
})
