// Durable renderer capture and resume must retain the launch-time account binding.
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentProfileConnectionService } from '../../src/main/agent-profiles/connection-service'
import {
  createClaudeProfileAdapter,
  createCodexProfileAdapter
} from '../../src/main/agent-profiles/provider-adapters'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentProfileSnapshot } from '../../src/shared/agent-launch-profile'
import { parseWorkspaceSession } from '../../src/shared/workspace-session-schema'
import { getDefaultSettings } from '../../src/shared/constants'
import { useAppStore } from '@/store'
import { launchSleepingAgentSession } from '@/lib/sleeping-agent-session-launch'
import {
  launchConfigsEqual,
  recoveryRecordMatches
} from '@/store/slices/agent-status-recovery-equivalence'
import type { SleepingAgentSessionRecord } from '../../src/shared/agent-session-resume'

const initial = useAppStore.getState()
afterEach(() => {
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})
function snapshot(): AgentProfileSnapshot {
  return {
    id: 'profile-a',
    name: 'A',
    agent: 'codex',
    hostId: 'local',
    executable: '/tools/codex',
    binding: { kind: 'managed', accountId: 'account-a' },
    resolvedHome: '/accounts/a',
    identity: { kind: 'verified', subject: 'subject-a', displayName: 'A' }
  }
}
function record(): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'session-a' },
    prompt: 'continue',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit',
    launchConfig: { agentArgs: '', agentEnv: {}, agentProfile: snapshot() }
  }
}
it('deep copies registered binding through sleep capture and persisted workspace parsing', () => {
  const captured = snapshot()
  const paneKey = 'tab-1:leaf-1'
  useAppStore.setState({
    agentStatusByPaneKey: {
      [paneKey]: {
        paneKey,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agentType: 'codex',
        state: 'working',
        prompt: 'continue',
        updatedAt: Date.now(),
        stateStartedAt: 1,
        stateHistory: [],
        providerSession: { key: 'session_id', id: 'session-a' }
      }
    }
  })
  useAppStore
    .getState()
    .registerAgentLaunchConfig(
      paneKey,
      { agentArgs: '', agentEnv: {}, agentProfile: captured },
      { agentType: 'codex' }
    )
  const registered =
    useAppStore.getState().agentLaunchConfigByPaneKey[paneKey].launchConfig.agentProfile
  expect(registered).toEqual(captured)
  expect(registered?.binding).not.toBe(captured.binding)
  expect(registered?.identity).not.toBe(captured.identity)
  captured.binding = { kind: 'managed', accountId: 'changed' }
  captured.identity = { kind: 'verified', subject: 'changed', displayName: 'changed' }
  useAppStore.getState().captureSleepingAgentSessionsByWorktree('wt-1')
  const sleeping = useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]
  expect(sleeping.launchConfig?.agentProfile).toEqual(snapshot())
  expect(sleeping.launchConfig?.agentProfile?.binding).not.toBe(registered?.binding)
  const result = parseWorkspaceSession(
    JSON.parse(
      JSON.stringify({
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        sleepingAgentSessionsByPaneKey: { [paneKey]: sleeping }
      })
    )
  )
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(
      result.value.sleepingAgentSessionsByPaneKey?.[paneKey].launchConfig?.agentProfile
    ).toEqual(snapshot())
  }
})
it.each(['home', 'identity', 'binding', 'missing'] as const)(
  'updates registry/recovery when profile %s changes',
  (change) => {
    const before = record()
    const changed = snapshot()
    if (change === 'home') {
      changed.resolvedHome = '/accounts/b'
    }
    if (change === 'identity') {
      changed.identity = { kind: 'verified', subject: 'subject-b', displayName: 'B' }
    }
    if (change === 'binding') {
      changed.binding = { kind: 'managed', accountId: 'account-b' }
    }
    const after = {
      ...before,
      launchConfig: {
        agentArgs: '',
        agentEnv: {},
        ...(change === 'missing' ? {} : { agentProfile: changed })
      }
    }
    expect(launchConfigsEqual(before.launchConfig, after.launchConfig)).toBe(false)
    expect(recoveryRecordMatches(before, after)).toBe(false)
    useAppStore
      .getState()
      .registerAgentLaunchConfig(before.paneKey, before.launchConfig!, { agentType: 'codex' })
    useAppStore
      .getState()
      .registerAgentLaunchConfig(before.paneKey, after.launchConfig, { agentType: 'codex' })
    expect(useAppStore.getState().agentLaunchConfigByPaneKey[before.paneKey].launchConfig).toEqual(
      after.launchConfig
    )
  }
)
it.each(['edited', 'unlinked'] as const)(
  'resumes captured profile after launcher is %s',
  (operation) => {
    const saved = record()
    useAppStore.setState({
      settings: {
        ...getDefaultSettings('/tmp/profile-recovery'),
        ...initial.settings,
        agentLaunchProfiles:
          operation === 'edited'
            ? [{ ...snapshot(), binding: { kind: 'managed', accountId: 'account-b' } }]
            : []
      }
    })
    expect(launchSleepingAgentSession(saved)).toBeTruthy()
    const pending = Object.values(useAppStore.getState().pendingStartupByTabId).find(
      (startup) => startup.resumeProviderSession?.id === 'session-a'
    )
    expect(pending?.launchConfig?.agentProfile).toEqual(snapshot())
    expect(pending?.launchConfig?.agentProfile?.identity).not.toBe(
      saved.launchConfig?.agentProfile?.identity
    )
  }
)

it.each(['home', 'identity'] as const)(
  'refuses %s drift using the snapshot emitted by sleeping resume',
  async (drift) => {
    const root = await mkdtemp(join(tmpdir(), 'renderer-profile-resume-'))
    try {
      const home = join(root, 'account')
      const otherHome = join(root, 'other')
      const executable = join(root, 'codex')
      await mkdir(home)
      await mkdir(otherHome)
      await writeFile(executable, 'synthetic executable, never run')
      await chmod(executable, 0o700)
      const saved = record()
      saved.launchConfig = {
        agentArgs: '',
        agentEnv: {},
        agentProfile: { ...snapshot(), resolvedHome: home, executable }
      }
      expect(launchSleepingAgentSession(saved)).toBe(true)
      const pending = Object.values(useAppStore.getState().pendingStartupByTabId).find(
        (startup) => startup.resumeProviderSession?.id === 'session-a'
      )
      const captured = pending?.launchConfig?.agentProfile
      expect(captured).toBeDefined()
      if (!captured) {
        throw new Error('Resume dropped its captured binding')
      }
      const prepareManaged = vi.fn()
      const service = new AgentProfileConnectionService({
        host: { hostId: 'local', platform: 'linux', isWsl: false, home: root, shell: '/bin/bash' },
        adapters: {
          claude: createClaudeProfileAdapter({
            inspectManaged: async () => {
              throw new Error('Unexpected Claude inspection')
            },
            prepareManaged
          }),
          codex: createCodexProfileAdapter({
            inspectManaged: async () => ({
              home: drift === 'home' ? otherHome : home,
              identity:
                drift === 'identity'
                  ? { kind: 'verified', subject: 'other-account', displayName: 'Other' }
                  : captured.identity
            }),
            prepareManaged
          })
        },
        detectExecutable: async () => executable,
        store: { read: () => [], write: async () => {} }
      })
      await expect(service.prepare(captured, { resume: true, mode: 'terminal' })).rejects.toThrow(
        drift === 'home' ? /home.*changed/i : /identity/i
      )
      expect(prepareManaged).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
)
