// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TaskProvider } from '../../../../shared/types'
import type { TaskProviderReadiness } from './task-source-setup-state'
import { useTaskSourceProviderReadiness } from './use-task-source-provider-readiness'

const mocks = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  skill: {
    installed: false,
    loading: false,
    settled: true,
    error: null,
    skills: [],
    refresh: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state)
}))

vi.mock('@/lib/local-preflight-context', () => ({
  getLocalPreflightContext: () => null,
  localPreflightContextKey: () => 'local'
}))

vi.mock('@/lib/provider-runtime-context', () => ({
  getProviderRuntimeContextKey: () => 'local'
}))

vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => ({ installDisabledReason: null })
}))

vi.mock('@/hooks/useLinearProviderConnected', () => ({
  useLinearProviderConnected: () => Boolean(mocks.state.linearConnected)
}))

vi.mock('@/hooks/useHulyProviderConnected', () => ({
  useHulyProviderConnected: () => Boolean(mocks.state.hulyConnected)
}))

vi.mock('@/hooks/useInstalledAgentSkills', () => ({
  GLOBAL_AGENT_SKILL_SOURCE_KINDS: ['home'],
  useInstalledAgentSkillNames: () => mocks.skill
}))

const ALL_PROVIDERS: readonly TaskProvider[] = ['github', 'gitlab', 'linear', 'jira', 'huly']

let root: Root | null = null
let container: HTMLDivElement | null = null
let latest: Record<TaskProvider, TaskProviderReadiness> | null = null

function Probe({ visibleProviders }: { visibleProviders: readonly TaskProvider[] }): null {
  latest = useTaskSourceProviderReadiness(visibleProviders)
  return null
}

async function renderProbe(
  visibleProviders: readonly TaskProvider[] = ALL_PROVIDERS
): Promise<void> {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(<Probe visibleProviders={visibleProviders} />)
  })
}

beforeEach(() => {
  mocks.state = {
    settings: {},
    preflightStatus: {
      gh: { installed: true, authenticated: true },
      glab: { installed: true, authenticated: true }
    },
    preflightStatusChecked: true,
    preflightStatusContextKey: 'local',
    preflightStatusError: null,
    preflightStatusLoading: false,
    jiraStatus: { connected: true },
    jiraStatusChecked: true,
    jiraStatusContextKey: 'local',
    linearStatusChecked: true,
    linearStatusContextKey: 'local',
    linearConnected: true,
    hulyStatus: { connected: false, cliInstalled: false, cliAuthenticated: false },
    hulyStatusChecked: true,
    hulyStatusContextKey: 'local',
    hulyConnected: false
  }
  mocks.skill = {
    installed: true,
    loading: false,
    settled: true,
    error: null,
    skills: [],
    refresh: vi.fn()
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
  latest = null
})

describe('useTaskSourceProviderReadiness', () => {
  it('reports every provider connected once checks land cleanly', async () => {
    await renderProbe()

    expect(latest?.github).toMatchObject({ connected: true, checking: false })
    expect(latest?.gitlab).toMatchObject({ connected: true, checking: false })
    expect(latest?.jira).toMatchObject({ connected: true, checking: false })
    expect(latest?.linear).toMatchObject({
      connected: true,
      checking: false,
      skillInstalled: true,
      skillChecking: false
    })
  })

  it('does not read code-host connection facts out of a failed preflight snapshot', async () => {
    // A failed refresh keeps the previous status object, so Integrations reports
    // GitHub as disconnected; Task Sources must not disagree.
    mocks.state.preflightStatusError = 'preflight failed'

    await renderProbe()

    expect(latest?.github.connected).toBe(false)
    expect(latest?.gitlab.connected).toBe(false)
    expect(latest?.github.unavailable).toBe(true)
    expect(latest?.gitlab.unavailable).toBe(true)
  })

  it('keeps the known skill result while a focus-triggered rescan is in flight', async () => {
    mocks.skill = { ...mocks.skill, loading: true, settled: true }

    await renderProbe()

    expect(latest?.linear).toMatchObject({ skillInstalled: true, skillChecking: false })
  })

  it('reports the skill as checking until the first scan settles', async () => {
    mocks.skill = { ...mocks.skill, installed: false, loading: true, settled: false }

    await renderProbe()

    expect(latest?.linear).toMatchObject({ skillInstalled: false, skillChecking: true })
  })

  it('marks providers hidden when they are not in the visible list', async () => {
    await renderProbe(['github', 'linear'])

    expect(latest?.github.visible).toBe(true)
    expect(latest?.linear.visible).toBe(true)
    expect(latest?.gitlab.visible).toBe(false)
    expect(latest?.jira.visible).toBe(false)
  })

  it('recomputes visibility when the provider list changes', async () => {
    await renderProbe(['github', 'linear'])
    expect(latest?.jira.visible).toBe(false)

    await renderProbe(['github', 'linear', 'jira'])
    expect(latest?.jira.visible).toBe(true)
  })

  it('reports Huly as disconnected and skill-uninstalled by default', async () => {
    mocks.skill = { ...mocks.skill, installed: false }
    await renderProbe()
    expect(latest?.huly.connected).toBe(false)
    expect(latest?.huly.skillInstalled).toBe(false)
    expect(latest?.huly.skillRequired).toBe(false)
    expect(latest?.huly.visible).toBe(true)
  })

  it('reports Huly as connected when hulyConnected flips on', async () => {
    mocks.state.hulyConnected = true
    await renderProbe()
    expect(latest?.huly.connected).toBe(true)
    expect(latest?.huly.checking).toBe(false)
  })

  it('reports Huly as still checking when the status context key does not match', async () => {
    mocks.skill = { ...mocks.skill, installed: false }
    mocks.state.hulyStatusContextKey = 'remote'
    mocks.state.hulyConnected = false
    await renderProbe()
    expect(latest?.huly.checking).toBe(true)
  })

  it('marks Huly hidden when the visible list excludes it', async () => {
    mocks.state.hulyConnected = true
    await renderProbe(['github', 'linear', 'jira'])
    expect(latest?.huly.visible).toBe(false)
  })
})
