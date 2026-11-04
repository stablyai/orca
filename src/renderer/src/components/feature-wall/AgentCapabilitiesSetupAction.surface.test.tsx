// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { SkillDiscoveryResult } from '../../../../shared/skills'
import type { BundledSkillPlanRequest } from '../../../../shared/bundled-skill-plan'
import type { BundledSkillTarget } from '@/lib/bundled-skill-target'
import type { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { doneResult, planOf, sharedEntry } from '../skills/bundled-skill-plan-fixtures.test-support'
import { AgentCapabilitiesSetupAction } from './AgentCapabilitiesSetupAction'

const mocks = vi.hoisted(() => {
  const project: Partial<ReturnType<typeof useActiveProjectSkillRuntime>> = {}
  return {
    project,
    plan: vi.fn(),
    execute: vi.fn(),
    discover: vi.fn(),
    catalogReady: true,
    web: false
  }
})
vi.mock('@/hooks/useActiveProjectSkillRuntime', () => ({
  useActiveProjectSkillRuntime: () => mocks.project
}))
vi.mock('@/runtime/runtime-bundled-skills-client', () => ({
  planBundledSkillsOnTarget: mocks.plan,
  executeBundledSkillsOnTarget: mocks.execute
}))
vi.mock('@/hooks/installed-agent-skill-discovery', async (importOriginal) => ({
  ...(await importOriginal()),
  discoverInstalledAgentSkills: mocks.discover
}))
vi.mock('../onboarding/FeatureSetupInlineTerminal', () => ({
  FeatureSetupInlineTerminal: () => <p>Inline terminal</p>
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('@/lib/chat-provider-agents', () => ({
  useHostStructuredAgentsVersion: () => 0,
  chatProviderAgents: () => ['claude', 'grok']
}))
vi.mock('@/runtime/host-structured-agents', async (importOriginal) => ({
  ...(await importOriginal()),
  readHostStructuredAgents: () => (mocks.catalogReady ? [] : undefined)
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

const initialApi = window.api
const initialState = useAppStore.getState()
const NAMES = ['orca-cli', 'orca-computer-use', 'orchestration']
const SERVER = { kind: 'environment', environmentId: 'agents-host' } as const
const browserChanged = vi.fn()

function skillsForGrok(): SkillDiscoveryResult {
  const root = '/home/u/.grok/skills'
  return {
    scannedAt: 1,
    sources: [
      {
        id: root,
        path: root,
        label: 'Grok',
        owner: 'grok',
        sourceKind: 'home',
        providers: ['agent-skills'],
        exists: true
      }
    ],
    skills: NAMES.map((name) => ({
      id: name,
      name,
      description: null,
      providers: ['agent-skills'],
      sourceKind: 'home',
      sourceLabel: 'Grok',
      rootPath: root,
      directoryPath: `${root}/${name}`,
      skillFilePath: `${root}/${name}/SKILL.md`,
      installed: true,
      updatedAt: 1
    }))
  }
}

function select(chat: boolean, agent: 'claude' | 'grok' | 'cursor' = 'claude'): void {
  useAppStore.setState({
    settings: createGlobalSettingsFixture({
      agentDefaultSurface: chat ? 'chat' : 'terminal',
      defaultTuiAgent: agent
    })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.catalogReady = true
  mocks.web = false
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText: vi.fn().mockResolvedValue(undefined) },
      computerUsePermissions: {
        getStatus: vi
          .fn()
          .mockResolvedValue({ platform: 'linux', helperUnavailableReason: null, permissions: [] })
      }
    }
  })
  mocks.project = {
    bundledSkillTarget: SERVER,
    discoveryRuntimeTarget: SERVER,
    installDisabledReason: null
  }
  select(true)
  mocks.discover.mockResolvedValue({ skills: [], sources: [], scannedAt: 1 })
  mocks.plan.mockImplementation(
    (_target: BundledSkillTarget, request: BundledSkillPlanRequest) => ({
      kind: 'plan',
      plan: planOf((request.names ?? []).map((name) => sharedEntry(name, 'write')))
    })
  )
  mocks.execute.mockResolvedValue(
    doneResult(planOf(NAMES.map((name) => sharedEntry(name, 'write'))))
  )
})
afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: initialApi })
  useAppStore.setState(initialState, true)
})

function setup() {
  return render(
    <AgentCapabilitiesSetupAction
      onBrowserUseSkillInstalledChange={browserChanged}
      onOrchestrationSkillInstalledChange={() => {}}
    />
  )
}

async function installSelectedSkills(): Promise<void> {
  const button = await screen.findByRole('button', { name: /^Install(?: skills)?$/ })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  fireEvent.click(button)
}

it('installs Chat UI skills locally even with a WSL project, then restores the terminal fallback when switched', async () => {
  mocks.project = {
    bundledSkillTarget: null,
    discoveryRuntimeTarget: { kind: 'local' },
    agentRuntime: { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' },
    discoveryTarget: { runtime: 'wsl', wslDistro: 'Ubuntu' },
    installDisabledReason: null
  }
  setup()
  await installSelectedSkills()
  await waitFor(() =>
    expect(mocks.execute).toHaveBeenCalledWith(
      { kind: 'local', agent: 'claude' },
      expect.any(String),
      { names: expect.arrayContaining(NAMES) }
    )
  )
  expect(mocks.discover).toHaveBeenCalledWith(
    expect.any(Boolean),
    { runtime: 'host' },
    { kind: 'local' },
    expect.anything(),
    ['home']
  )
  expect(screen.queryByText('Inline terminal')).toBeNull()

  await act(async () => select(false))
  await installSelectedSkills()
  expect(await screen.findByText('Inline terminal')).toBeDefined()
  expect(mocks.execute).toHaveBeenCalledTimes(1)
})

it('checks the selected chat agent roots and rechecks when switching to a remote terminal', async () => {
  mocks.discover.mockImplementation((_force, _discovery, runtime) =>
    Promise.resolve(
      runtime.kind === 'local' ? skillsForGrok() : { skills: [], sources: [], scannedAt: 1 }
    )
  )
  setup()
  await screen.findByRole('button', { name: /^Install(?: skills)?$/ })
  expect(browserChanged).toHaveBeenLastCalledWith(false)
  await act(async () => select(true, 'grok'))
  await waitFor(() => expect(browserChanged).toHaveBeenLastCalledWith(true))
  await act(async () => select(false, 'grok'))
  await waitFor(() => expect(browserChanged).toHaveBeenLastCalledWith(false))
  await installSelectedSkills()
  await waitFor(() =>
    expect(mocks.execute).toHaveBeenCalledWith(SERVER, expect.any(String), expect.anything())
  )
})

it('does not carry an in-flight chat installation result into terminal mode', async () => {
  let finish!: (value: Awaited<ReturnType<typeof doneResult>>) => void
  mocks.execute.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  setup()
  await installSelectedSkills()
  await waitFor(() => expect(mocks.execute).toHaveBeenCalledTimes(1))
  await act(async () => select(false))
  await screen.findByRole('button', { name: /^Install(?: skills)?$/ })
  await act(async () => finish(doneResult(planOf(NAMES.map((name) => sharedEntry(name, 'write'))))))
  expect(
    screen.getByRole('button', { name: /^Install(?: skills)?$/ }).hasAttribute('disabled')
  ).toBe(false)
})

it('keeps terminal-only agents on the project runtime when Chat UI is enabled', async () => {
  select(true, 'cursor')
  setup()
  await installSelectedSkills()
  await waitFor(() =>
    expect(mocks.execute).toHaveBeenCalledWith(SERVER, expect.any(String), expect.anything())
  )
})

it('waits for the chat catalog before routing an unrecognized selection to a terminal host', async () => {
  mocks.catalogReady = false
  select(true, 'cursor')
  setup()
  const button = await screen.findByRole('button', { name: /^Install(?: skills)?$/ })
  expect(button.hasAttribute('disabled')).toBe(true)
  expect(mocks.plan).not.toHaveBeenCalled()
  expect(mocks.discover).not.toHaveBeenCalled()
})

it('keeps paired browser clients on their server instead of using desktop IPC', async () => {
  mocks.web = true
  setup()
  await installSelectedSkills()
  await waitFor(() =>
    expect(mocks.execute).toHaveBeenCalledWith(SERVER, expect.any(String), expect.anything())
  )
})
