// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContextReport } from '../../../../shared/agent-context'
import type { DiscoveredSkill, SkillDiscoverySource } from '../../../../shared/skills'
import {
  agentsInContext,
  filterReportByAgent,
  groupInstructionFiles,
  selectSkillsForAgent,
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
vi.mock('@/components/agent/AgentCombobox', () => ({
  default: ({
    value,
    agents,
    onValueChange
  }: {
    value: string | null
    agents: { id: string }[]
    onValueChange: (agent: string | null) => void
  }) => (
    <select
      data-testid="agent-filter"
      value={value ?? ''}
      onChange={(event) => onValueChange(event.target.value || null)}
    >
      <option value="">All agents</option>
      {agents.map((agent) => (
        <option key={agent.id} value={agent.id}>
          {agent.id}
        </option>
      ))}
    </select>
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
    const checkbox = container.querySelector('[role="checkbox"]') as HTMLButtonElement
    act(() => {
      checkbox.click()
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
    const mcpTab = [...container.querySelectorAll('[role="tab"]')].find(
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
    const select = container.querySelector('[data-testid="agent-filter"]') as HTMLSelectElement
    expect([...select.options].map((option) => option.value)).toEqual(['', 'claude', 'gemini'])
    act(() => {
      select.value = 'gemini'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const checkbox = container.querySelector('[role="checkbox"]') as HTMLButtonElement
    act(() => checkbox.click())
    const text = container.textContent ?? ''
    expect(text).toContain('GEMINI.md')
    expect(text).not.toContain('/home/u/repo/CLAUDE.md')
    expect(text).not.toContain('linear')
    expect(text).not.toContain('adhd@local')
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

  it('narrows the report and skills to one agent', () => {
    const full = report()
    const claude = filterReportByAgent(full, 'claude')
    expect(claude?.instructionFiles.map((file) => file.id)).toEqual([
      'home-claude-md',
      'project-claude-md'
    ])
    expect(claude?.mcpFiles).toHaveLength(1)
    const gemini = filterReportByAgent(full, 'gemini')
    expect(gemini?.instructionFiles.map((file) => file.id)).toEqual(['project-gemini-md'])
    expect(gemini?.mcpFiles).toHaveLength(0)
    expect(gemini?.plugins).toHaveLength(0)
    expect(filterReportByAgent(full, null)).toBe(full)

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
    expect(selectSkillsForAgent(skills, sources, 'grok').map((entry) => entry.id)).toEqual([
      'shared',
      'grok-only'
    ])
    expect(selectSkillsForAgent(skills, sources, 'claude').map((entry) => entry.id)).toEqual([
      'shared',
      'claude-only',
      'plugin'
    ])
    expect(agentsInContext(full, skills, sources).sort()).toEqual(
      ['claude', 'gemini', 'grok'].sort()
    )
  })
})
