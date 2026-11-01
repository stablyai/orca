// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import { doneResult, planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { TooltipProvider } from '../ui/tooltip'
import { JiraIntegrationCard } from './jira-integration-card'

const WRITE_PLAN = planOf([sharedEntry('orca-jira', 'write')])

type StoreState = {
  jiraStatus: {
    connected: boolean
    sites?: { id: string; displayName: string; siteUrl: string; email?: string }[]
  }
  jiraStatusChecked: boolean
  jiraStatusContextKey: string | null
  checkJiraConnection: () => Promise<void>
  disconnectJira: (siteId?: string) => Promise<void>
  testJiraConnection: (siteId: string) => Promise<{ ok: boolean; error?: string }>
  settings: { activeRuntimeEnvironmentId: string | null }
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: string; repoId: string | null }) => void
  runtimeStatusByEnvironmentId: Map<string, unknown>
  runtimeEnvironments: { id: string }[]
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  store: { current: null as StoreState | null }
}))

const skillMocks = vi.hoisted(() => ({
  skillTarget: ((): BundledSkillTarget => ({ kind: 'local' }))(),
  plan: vi.fn(),
  execute: vi.fn()
}))

vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: skillMocks.plan,
  executeBundledSkillsOnTarget: skillMocks.execute
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({
    bundledSkillTarget: skillMocks.skillTarget,
    installDisabledReason: null,
    canUseSkillFreshness: false
  })
}))

vi.mock('@/hooks/useInstalledAgentSkills', async (importOriginal) => ({
  ...(await importOriginal()),
  useInstalledAgentSkill: () => ({
    installed: false,
    loading: false,
    settled: true,
    installedUnverifiable: false,
    error: null,
    skills: [],
    sources: [],
    refresh: async () => true
  })
}))

vi.mock('@/hooks/installed-agent-skill-discovery', () => ({
  notifyInstalledAgentSkillsChanged: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => {
    if (!mocks.store.current) {
      throw new Error('Store state was not installed')
    }
    return selector(mocks.store.current)
  }
}))

vi.mock('@/components/jira-connect-dialog', () => ({
  JiraConnectDialog: ({ onConnected }: { onConnected?: () => void }) => (
    <button type="button" data-testid="simulate-jira-connected" onClick={onConnected}>
      Simulate Jira connected
    </button>
  )
}))

let root: Root | null = null
let container: HTMLDivElement | null = null

function installStore(settings: StoreState['settings']): StoreState {
  const state: StoreState = {
    jiraStatus: {
      connected: true,
      sites: [
        {
          id: 'site-1',
          displayName: 'Acme Jira',
          siteUrl: 'https://acme.atlassian.net',
          email: 'jira@example.test'
        }
      ]
    },
    jiraStatusChecked: true,
    jiraStatusContextKey: getProviderRuntimeContextKey(settings),
    checkJiraConnection: vi.fn(async () => {}),
    disconnectJira: vi.fn(async () => {}),
    testJiraConnection: vi.fn(async () => ({ ok: true })),
    settings,
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    runtimeStatusByEnvironmentId: new Map(),
    runtimeEnvironments: []
  }
  mocks.store.current = state
  return state
}

async function renderCard(): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <TooltipProvider>
        <JiraIntegrationCard />
      </TooltipProvider>
    )
  })
  return container
}

describe('JiraIntegrationCard account scope', () => {
  beforeEach(() => {
    skillMocks.skillTarget = { kind: 'local' }
    skillMocks.plan.mockReset()
    skillMocks.plan.mockResolvedValue({ kind: 'plan', plan: WRITE_PLAN })
    skillMocks.execute.mockReset()
    skillMocks.execute.mockResolvedValue(doneResult(WRITE_PLAN))
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
    mocks.store.current = null
    await i18n.changeLanguage(await loadRendererUiLanguage('en'))
  })

  it.each(['en', 'ko'] as const)(
    'renders complete %s connection counts without an English suffix',
    async (language) => {
      await i18n.changeLanguage(await loadRendererUiLanguage(language))
      for (const count of [0, 1, 2]) {
        const state = installStore({ activeRuntimeEnvironmentId: null })
        state.jiraStatus.sites = Array.from({ length: count }, (_, index) => ({
          id: `site-${index}`,
          displayName: 'Fixture Jira',
          siteUrl: 'https://fixture.example.test'
        }))
        state.jiraStatus.connected = count > 0
        const rendered = await renderCard()
        const description =
          rendered.querySelector('[data-settings-section="integrations-jira"]')?.textContent ?? ''
        const expected =
          language === 'ko'
            ? `사이트 ${count}개 연결됨`
            : `${count} site${count === 1 ? '' : 's'} connected`
        if (count === 0) {
          expect(description).not.toContain(expected)
          expect(description).not.toContain('0 site')
        } else {
          expect(description).toContain(expected)
        }
        expect(description).not.toMatch(/개(?: 사이트| 워크스페이스)?s/)
        await act(async () => {
          root?.unmount()
        })
        root = null
        container?.remove()
        container = null
      }
    }
  )

  it('shows remote-server account ownership and opens Hosts settings', async () => {
    const state = installStore({ activeRuntimeEnvironmentId: 'runtime-1' })

    const rendered = await renderCard()

    expect(rendered.querySelector('[data-settings-section="integrations-jira"]')).not.toBeNull()
    expect(rendered.textContent).toContain('Account scope: Remote server: runtime-1')
    expect(rendered.textContent).toContain('Acme Jira')
    expect(rendered.textContent).toContain('https://acme.atlassian.net · jira@example.test')

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Open Remote Servers')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(state.openSettingsPage).toHaveBeenCalledTimes(1)
    expect(state.openSettingsTarget).toHaveBeenCalledWith({
      pane: 'servers',
      repoId: null,
      sectionId: 'default-runtime'
    })
  })

  it('installs orca-jira on the paired host that owns the Jira connection', async () => {
    skillMocks.skillTarget = { kind: 'environment', environmentId: 'runtime-1' }
    installStore({ activeRuntimeEnvironmentId: 'runtime-1' })

    const rendered = await renderCard()
    await act(async () => {})
    expect(rendered.textContent).toContain('Agent skill: orca-jira')

    await act(async () => {
      Array.from(rendered.querySelectorAll('button'))
        .find((button) => button.textContent === 'Install')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(skillMocks.plan).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'runtime-1' },
      { names: ['orca-jira'] }
    )
    expect(skillMocks.execute).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'runtime-1' },
      WRITE_PLAN.planDigest,
      { names: ['orca-jira'] }
    )
  })
})
