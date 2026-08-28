// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TaskProvider } from '../../../../shared/task-providers'
import type { TaskProviderReadiness } from './task-source-setup-state'
import { TasksPane } from './TasksPane'

const mocks = vi.hoisted(() => ({
  readiness: {} as Record<TaskProvider, TaskProviderReadiness>,
  openSettingsTarget: vi.fn(),
  openSettingsPage: vi.fn(),
  refreshPreflightStatus: vi.fn(),
  checkLinearConnection: vi.fn(),
  checkJiraConnection: vi.fn(),
  linearSetupProps: [] as {
    connected: boolean
    checking: boolean
    onOpenIntegrations: () => void
  }[],
  jiraSetupProps: [] as { onOpenIntegrations: () => void }[]
}))

vi.mock('./use-task-source-provider-readiness', () => ({
  useTaskSourceProviderReadiness: () => mocks.readiness
}))

vi.mock('./use-integration-provider-status-refresh', () => ({
  useIntegrationProviderStatusRefresh: vi.fn()
}))

vi.mock('./TaskSourceLinearSetup', () => ({
  TaskSourceLinearSetup: (props: {
    connected: boolean
    checking: boolean
    onOpenIntegrations: () => void
  }) => {
    mocks.linearSetupProps.push(props)
    return <div data-testid="linear-setup">Linear setup steps</div>
  }
}))

vi.mock('./TaskSourceSimpleSetup', () => ({
  CodeHostSetupSteps: (props: {
    providerLabel: string
    unavailable?: boolean
    onRetryConnection: () => void
  }) => (
    <div data-testid={`code-host-${props.providerLabel}`}>
      {props.unavailable ? (
        <>
          <span>Orca couldn&apos;t check this connection</span>
          <button type="button" onClick={props.onRetryConnection}>
            Try again
          </button>
        </>
      ) : (
        'Code host setup'
      )}
    </div>
  ),
  JiraSetupSteps: (props: { onOpenIntegrations: () => void }) => {
    mocks.jiraSetupProps.push(props)
    return <div data-testid="jira-setup">Jira setup</div>
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (
    selector: (state: {
      openSettingsPage: () => void
      openSettingsTarget: (target: unknown) => void
      refreshPreflightStatus: () => void
      checkLinearConnection: () => void
      checkJiraConnection: () => void
      settingsSearchQuery: string
    }) => unknown
  ) =>
    selector({
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget,
      refreshPreflightStatus: mocks.refreshPreflightStatus,
      checkLinearConnection: mocks.checkLinearConnection,
      checkJiraConnection: mocks.checkJiraConnection,
      settingsSearchQuery: ''
    })
}))

const baseSettings = {
  visibleTaskProviders: ['github', 'gitlab', 'linear'],
  defaultTaskSource: 'github'
} as GlobalSettings

const INCOMPLETE_BANNER = 'Some visible providers still need setup'
const LINEAR_SETUP_MARKER = 'data-testid="linear-setup"'

function renderPane(): string {
  return renderToStaticMarkup(<TasksPane settings={baseSettings} updateSettings={vi.fn()} />)
}

let root: Root | null = null
let container: HTMLDivElement | null = null

async function renderInteractivePane(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(<TasksPane settings={baseSettings} updateSettings={vi.fn()} />)
  })
  return container
}

async function rerenderInteractivePane(): Promise<void> {
  await act(async () => {
    root?.render(<TasksPane settings={baseSettings} updateSettings={vi.fn()} />)
  })
}

describe('TasksPane', () => {
  beforeEach(() => {
    mocks.linearSetupProps = []
    mocks.jiraSetupProps = []
    mocks.openSettingsPage.mockClear()
    mocks.openSettingsTarget.mockClear()
    mocks.readiness = {
      github: { connected: true, checking: false, visible: true },
      gitlab: { connected: true, checking: false, visible: true },
      // Started-then-stalled: a Linear key is stored but agents have no skill.
      linear: {
        connected: true,
        checking: false,
        skillInstalled: false,
        skillChecking: false,
        visible: true
      },
      jira: { connected: false, checking: false, visible: false }
    }
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

  it('frames Task Sources as a guided setup hub, not visibility-only toggles', () => {
    const markup = renderPane()

    expect(markup).toContain('Task management setup')
    expect(markup).toContain('Linear also needs the agent skill')
    expect(markup).toContain(INCOMPLETE_BANNER)
    expect(markup).toContain('Linear setup steps')
    expect(markup).toContain('Hide providers you do not use')
    expect(markup).toContain('API access, the agent skill, and Show in Tasks')
  })

  it('does not warn on a fresh install where nothing is connected yet', () => {
    // Settings ship with every provider visible, so untouched providers are the
    // default state; the cards still say "Connect required" on their own.
    mocks.readiness.github = { connected: false, checking: false, visible: true }
    mocks.readiness.gitlab = { connected: false, checking: false, visible: true }
    mocks.readiness.linear = {
      connected: false,
      checking: false,
      skillInstalled: false,
      skillChecking: false,
      visible: true
    }
    mocks.readiness.jira = { connected: false, checking: false, visible: true }

    const markup = renderPane()

    expect(markup).not.toContain(INCOMPLETE_BANNER)
    expect(markup).toContain('Connect required')
  })

  it('hides the incomplete banner when every visible provider is ready', () => {
    mocks.readiness.linear = {
      connected: true,
      checking: false,
      skillInstalled: true,
      skillChecking: false,
      visible: true
    }

    expect(renderPane()).not.toContain(INCOMPLETE_BANNER)
  })

  it('does not warn or expand while connection checks are still in flight', () => {
    mocks.readiness.github = { connected: false, checking: true, visible: true }
    mocks.readiness.gitlab = { connected: false, checking: true, visible: true }
    mocks.readiness.linear = {
      connected: false,
      checking: true,
      skillInstalled: false,
      skillChecking: true,
      visible: true
    }

    const markup = renderPane()

    expect(markup).not.toContain(INCOMPLETE_BANNER)
    expect(markup).not.toContain(LINEAR_SETUP_MARKER)
  })

  it('passes context-safe readiness into the expanded Linear setup', () => {
    renderPane()

    expect(mocks.linearSetupProps).toEqual([
      expect.objectContaining({ connected: true, checking: false })
    ])
  })

  it('deep-links connected Linear credential management to its integration card', async () => {
    await renderInteractivePane()

    mocks.linearSetupProps.at(-1)?.onOpenIntegrations()

    expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'integrations',
      repoId: null,
      sectionId: 'integrations-linear'
    })
  })

  it('deep-links connected Jira credential management to its integration card', async () => {
    mocks.readiness.jira = { connected: true, checking: false, visible: true }
    await renderInteractivePane()
    const expandJira = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.getAttribute('aria-label') === 'Show Jira setup steps'
    )

    await act(async () => {
      expandJira?.click()
    })
    mocks.jiraSetupProps.at(-1)?.onOpenIntegrations()

    expect(mocks.openSettingsPage).toHaveBeenCalledOnce()
    expect(mocks.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'integrations',
      repoId: null,
      sectionId: 'integrations-jira'
    })
  })

  it('auto-expands only the first incomplete provider', () => {
    mocks.readiness.gitlab = { connected: false, checking: false, visible: true }

    const markup = renderPane()

    // GitLab is first in provider order, so Linear stays collapsed.
    expect(markup).toContain('Code host setup')
    expect(markup).not.toContain(LINEAR_SETUP_MARKER)
  })

  it('leaves hidden providers out of the incomplete warning', () => {
    mocks.readiness.linear = {
      connected: true,
      checking: false,
      skillInstalled: false,
      skillChecking: false,
      visible: false
    }

    expect(renderPane()).not.toContain(INCOMPLETE_BANNER)
  })

  it('keeps Linear setup mounted while a skill recheck is in flight after auto-expand', async () => {
    // Same component instance keeps the sticky auto-expand ref across rechecks.
    await renderInteractivePane()
    expect(container?.querySelector('[data-testid="linear-setup"]')).not.toBeNull()
    expect(container?.textContent).toContain(INCOMPLETE_BANNER)

    mocks.readiness.linear = {
      connected: true,
      checking: false,
      skillInstalled: false,
      skillChecking: true,
      visible: true
    }
    await rerenderInteractivePane()

    // Sticky expand keeps the (possibly open) install terminal mounted mid-scan.
    expect(container?.querySelector('[data-testid="linear-setup"]')).not.toBeNull()
  })

  it('keeps the auto-expanded card open after hiding it instead of popping another open', async () => {
    await renderInteractivePane()
    expect(container?.querySelector('[data-testid="linear-setup"]')).not.toBeNull()

    // Hiding the stalled provider is the banner's own advice; GitHub must not
    // silently take over the expansion on a later unrelated render.
    mocks.readiness.linear = {
      connected: true,
      checking: false,
      skillInstalled: false,
      skillChecking: false,
      visible: false
    }
    mocks.readiness.github = { connected: false, checking: false, visible: true }
    await rerenderInteractivePane()
    await rerenderInteractivePane()

    expect(container?.querySelector('[data-testid="linear-setup"]')).not.toBeNull()
    expect(container?.textContent).not.toContain('Code host setup')
  })

  it('keeps Linear expanded when the slower code-host preflight lands after it', async () => {
    // Cold open: nothing has resolved, so no card auto-expands yet.
    mocks.readiness.github = { connected: false, checking: true, visible: true }
    mocks.readiness.gitlab = { connected: false, checking: true, visible: true }
    mocks.readiness.linear = {
      connected: false,
      checking: true,
      skillInstalled: false,
      skillChecking: true,
      visible: true
    }
    await renderInteractivePane()
    expect(container?.querySelector('[data-testid="linear-setup"]')).toBeNull()

    // Linear status + skill scan land first, so Linear auto-expands.
    mocks.readiness.linear = {
      connected: true,
      checking: false,
      skillInstalled: false,
      skillChecking: false,
      visible: true
    }
    await rerenderInteractivePane()
    expect(container?.querySelector('[data-testid="linear-setup"]')).not.toBeNull()

    // gh/glab preflight lands last with gh unauthenticated: GitHub is now the
    // first incomplete provider, but it must not steal Linear's expansion.
    mocks.readiness.github = { connected: false, checking: false, visible: true }
    mocks.readiness.gitlab = { connected: false, checking: false, visible: true }
    await rerenderInteractivePane()

    expect(container?.querySelector('[data-testid="linear-setup"]')).not.toBeNull()
  })

  it('does not warn about an unconnected code host once Linear is finished', () => {
    // A code host is single-step, so "not connected" is never a stalled setup.
    mocks.readiness.linear = {
      connected: true,
      checking: false,
      skillInstalled: true,
      skillChecking: false,
      visible: true
    }
    mocks.readiness.github = { connected: false, checking: false, visible: true }

    expect(renderPane()).not.toContain(INCOMPLETE_BANNER)
  })

  it('shows a retry action instead of setup instructions when preflight is unavailable', async () => {
    mocks.readiness.github = {
      connected: false,
      checking: false,
      unavailable: true,
      visible: true
    }
    mocks.readiness.gitlab = { connected: true, checking: false, visible: true }
    mocks.readiness.linear = {
      connected: true,
      checking: false,
      skillInstalled: true,
      skillChecking: false,
      visible: true
    }
    await renderInteractivePane()

    expect(container?.textContent).toContain('Status unavailable')
    expect(container?.textContent).toContain("Orca couldn't check this connection")
    const retry = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Try again'
    )
    expect(retry).toBeDefined()

    await act(async () => {
      retry?.click()
    })
    expect(mocks.refreshPreflightStatus).toHaveBeenCalledWith({ force: true })
  })
})
