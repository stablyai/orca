// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContextReport } from '../../../../shared/agent-context'
import type { DiscoveredSkill } from '../../../../shared/skills'
import { selectWorkspaceSkills, groupInstructionFiles } from './workspace-context-model'

const testState = vi.hoisted(() => ({
  worktree: null as null | { id: string; path: string; branch: string },
  context: {
    report: null as AgentContextReport | null,
    loading: false,
    error: null as string | null,
    skills: [] as DiscoveredSkill[],
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
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
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
})
