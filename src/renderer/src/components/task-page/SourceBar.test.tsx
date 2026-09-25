// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import type { ContributedPluginTaskSource } from '@/store/slices/plugin-task-sources-slice-contract'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { getSourceOptions } from '../task-page-localized-options'
import { TaskPageSourceBar } from './SourceBar'

vi.mock('@/store/plugin-task-source-contributions', () => ({
  usePluginTaskSourceContributions: (): void => {}
}))

const BOARDS: ContributedPluginTaskSource = {
  pluginKey: 'orca-samples.azure-boards',
  sourceId: 'boards',
  title: 'Azure Boards'
}

function buildModel(
  overrides: Partial<TaskPageComposerActionsModel> = {}
): TaskPageComposerActionsModel {
  const base = {
    openTaskPage: vi.fn(),
    closeTaskPage: vi.fn(),
    updateSettings: vi.fn(() => Promise.resolve()),
    selectJiraSite: vi.fn(() => Promise.resolve()),
    linearConnected: true,
    jiraConnected: true,
    linearWorkspaces: [],
    selectedLinearWorkspaceId: null,
    jiraSites: [
      { id: 'site-a', displayName: 'Site A', siteUrl: 'https://a.example' },
      { id: 'site-b', displayName: 'Site B', siteUrl: 'https://b.example' }
    ],
    selectedJiraSiteId: 'site-a',
    visibleSourceOptions: getSourceOptions(),
    taskSource: 'jira',
    taskSourceAvailabilityNoticeByProvider: {},
    taskSourceContextSummary: { title: 'Jira', label: 'Jira' },
    taskSourceManuallyChangedRef: { current: false },
    setSelectedJiraIssueKey: vi.fn(),
    setSelectedJiraIssueFallback: vi.fn(),
    setJiraIssues: vi.fn(),
    setJiraLoading: vi.fn(),
    setJiraError: vi.fn(),
    defaultLinearTeamSelection: null,
    linearTeamSelection: [],
    linearTeamOptions: [],
    selectedLinearTeamForExternalLink: null,
    setLinearConnectOpen: vi.fn(),
    handleLinearWorkspaceChange: vi.fn(),
    handleLinearTeamSelectionChange: vi.fn(),
    handleLinearScopeOpen: vi.fn(),
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the literal names every field TaskPageSourceBar destructures; a field it starts reading is absent at runtime and fails the test rather than passing quietly.
  return base as unknown as TaskPageComposerActionsModel
}

function renderBar(overrides: Partial<TaskPageComposerActionsModel> = {}): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      <TaskPageSourceBar model={buildModel(overrides)} />
    </TooltipProvider>
  )
  return container
}

function pressedLabels(): string[] {
  return screen
    .getAllByRole('button')
    .filter((button) => button.getAttribute('aria-pressed') === 'true')
    .map((button) => button.getAttribute('aria-label') ?? '')
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ pluginTaskSources: [BOARDS] })
})

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('TaskPage source bar active tab', () => {
  it('marks the matching built-in tab active when no contributed source is selected', () => {
    renderBar()

    const jira = screen.getByRole('button', { name: 'Jira' })
    expect(jira).toHaveAttribute('aria-pressed', 'true')
    expect(jira.className).toContain('border-foreground/40')
  })

  it('drops the built-in tab from active while a contributed source is selected', () => {
    useAppStore.setState({
      selectedPluginTaskSource: { pluginKey: BOARDS.pluginKey, sourceId: BOARDS.sourceId }
    })

    renderBar()

    const jira = screen.getByRole('button', { name: 'Jira' })
    expect(jira).toHaveAttribute('aria-pressed', 'false')
    expect(jira.className).not.toContain('border-foreground/40')
  })

  it('presses exactly one tab whichever source owns the bar', () => {
    renderBar()
    expect(pressedLabels()).toEqual(['Jira'])

    cleanup()
    useAppStore.setState({
      selectedPluginTaskSource: { pluginKey: BOARDS.pluginKey, sourceId: BOARDS.sourceId }
    })
    renderBar()
    expect(pressedLabels()).toEqual(['Azure Boards'])
  })
})

describe('TaskPage source bar trailing panels', () => {
  it('shows the Jira site picker when Jira owns the bar', () => {
    renderBar()

    expect(screen.getByRole('combobox')).toBeInTheDocument()
  })

  it('hides the Jira site picker while a contributed source is selected', () => {
    useAppStore.setState({
      selectedPluginTaskSource: { pluginKey: BOARDS.pluginKey, sourceId: BOARDS.sourceId }
    })

    renderBar({ taskSource: 'jira' })

    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('hides the Linear scope selector while a contributed source is selected', () => {
    useAppStore.setState({
      selectedPluginTaskSource: { pluginKey: BOARDS.pluginKey, sourceId: BOARDS.sourceId }
    })

    renderBar({ taskSource: 'linear' })

    expect(
      screen.queryByRole('button', { name: 'Select one Linear team to open in Linear' })
    ).toBeNull()
  })

  it('shows the Linear scope selector when Linear owns the bar', () => {
    renderBar({ taskSource: 'linear' })

    expect(
      screen.getByRole('button', { name: 'Select one Linear team to open in Linear' })
    ).toBeInTheDocument()
  })
})

describe('TaskPage source bar spacing', () => {
  it('renders no divider between the built-in tabs and the contributed ones', () => {
    const container = renderBar()

    const contributed = screen.getByRole('button', { name: 'Azure Boards' })
    expect(contributed.previousElementSibling).toHaveAttribute('aria-label', 'Jira')

    const dividers = container.querySelectorAll('div.w-px')
    expect(dividers).toHaveLength(1)
    expect(dividers[0]?.nextElementSibling).toHaveAttribute('aria-label', 'GitHub')
  })
})
