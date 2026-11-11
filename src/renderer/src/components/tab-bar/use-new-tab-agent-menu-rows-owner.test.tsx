// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AGENT_CATALOG } from '@/lib/agent-catalog/agent-catalog'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'

import { useAgentDetectionTargetForWorktree } from '@/hooks/useAgentDetectionTarget'
import '@/lib/agent-session/launch/routing/agent-launch-route-input'

import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'

import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { resetRendererAppPlatformCacheForTests } from '@/app-shell/platform/renderer-app-platform'

import { getDefaultSettings } from '../../../../shared/constants'
import type { AppState } from '@/store/types'
import type { Repo } from '../../../../shared/repo-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'

import { useAgentMenuObservation } from './use-new-tab-agent-menu-rows'
import '@/lib/source-control/ai/source-control-agent-picker'
import { createAgentMenuTerminalPendingSelector } from './agent-menu-launch-facts'

import { connectedRuntimeStatus } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { runtimeEnvironmentStatusFromSnapshot } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../shared/runtime-session-contracts'
const initial = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  setLocalRuntimeCapabilitiesForTests(null)
  resetRendererAppPlatformCacheForTests()
})

const worktreeId = 'r1::/remote'
const sshState = {
  targetId: 'box',
  status: 'connecting' as const,
  error: null,
  reconnectAttempt: 0
}
const repo: Repo = { ...TEST_REPO, id: 'r1', connectionId: 'box', executionHostId: 'ssh:box' }

/** An SSH workspace whose host has not reported its OS, with Codex's CLI already detected. */
function seedSshWorkspace(): void {
  setLocalRuntimeCapabilitiesForTests([])
  useAppStore.setState({
    ...initial,
    settings: { ...getDefaultSettings('/home/me'), agentDefaultSurface: 'terminal' },
    activeWorktreeId: worktreeId,
    repos: [repo],
    worktreesByRepo: {
      r1: [makeWorktree({ id: worktreeId, repoId: 'r1', hostId: 'ssh:box', path: '/remote' })]
    },
    remoteDetectedAgentIds: { box: ['codex'] },
    sshConnectionStates: new Map([['box', sshState]]),
    ensureRemoteDetectedAgents: vi.fn<AppState['ensureRemoteDetectedAgents']>(async () => ['codex'])
  })
}

it('lets the picker open to choose chat while only the chosen terminal waits for SSH', () => {
  seedSshWorkspace()
  let ready: boolean | undefined
  function Picker() {
    const observation = useAgentMenuObservation(
      worktreeId,
      true,
      useAgentDetectionTargetForWorktree(worktreeId)
    )
    const selection = observation.selectionFor('codex', 'terminal')
    ready = selection.ready
    return (
      <AgentCombobox
        agents={AGENT_CATALOG}
        value="codex"
        onValueChange={vi.fn()}
        surfaceRows={{ model: observation.model, selection, surface: 'terminal', onPick: vi.fn() }}
      />
    )
  }
  render(<Picker />, { wrapper: TooltipProvider })
  // Starting the terminal waits; choosing another surface in the picker does not.
  expect(ready).toBe(false)
  expect(screen.getByRole('combobox').hasAttribute('disabled')).toBe(false)
})

/** Copies whose `id` reads are counted: every index build and owner scan reads it. */

/** Closed pickers, each counting its own renders once mount effects settle. */

const connecting = (targetId: string) => ({ ...sshState, targetId })
const linux = (targetId: string) => ({
  ...connecting(targetId),
  status: 'connected' as const,
  remotePlatform: 'linux' as const
})
const direct = (box: SshConnectionState, other: SshConnectionState) =>
  new Map([
    ['box', box],
    ['other', other]
  ])
// A paired server's own connection to `box`, as it publishes it.

it("re-derives a cached host when the workspace's owner moves in a new snapshot", async () => {
  setLocalRuntimeCapabilitiesForTests([])
  const local: Repo = { ...TEST_REPO, id: 'r1', path: '/work' }
  const owned = (hostId: 'local' | 'ssh:box') => ({
    repos: [
      hostId === 'local' ? local : { ...local, connectionId: 'box', executionHostId: hostId }
    ],
    worktreesByRepo: {
      r1: [makeWorktree({ id: 'r1::/work', repoId: 'r1', hostId, path: '/work' })]
    }
  })
  useAppStore.setState({
    ...initial,
    settings: { ...getDefaultSettings('/home/me'), agentDefaultSurface: 'terminal' },
    ...owned('local'),
    detectedAgentIds: ['codex'],
    remoteDetectedAgentIds: { box: ['codex'] },
    sshConnectionStates: direct(connecting('box'), connecting('other'))
  })
  const pending = createAgentMenuTerminalPendingSelector({ worktreeId: 'r1::/work' })
  expect(pending(useAppStore.getState())).toBe(false)
  // The move arrives as one publication while `box` is still connecting.
  useAppStore.setState(owned('ssh:box'))
  expect(pending(useAppStore.getState())).toBe(true)
  useAppStore.setState({ sshConnectionStates: direct(linux('box'), connecting('other')) })
  expect(pending(useAppStore.getState())).toBe(false)
  useAppStore.setState({ sshConnectionStates: direct(connecting('box'), connecting('other')) })
  expect(pending(useAppStore.getState())).toBe(true)
  useAppStore.setState(owned('local'))
  expect(pending(useAppStore.getState())).toBe(false)
})

it('waits on a paired server only while contact is checking without a reported OS', () => {
  const worktree = makeWorktree({
    id: 'r1::/srv',
    repoId: 'r1',
    hostId: 'runtime:srv',
    runtimeOwnerEnvironmentId: 'srv'
  })
  const answered = connectedRuntimeStatus('srv-runtime', 1).status
  // The host status snapshot the client publishes as it reaches the server.
  const contact = (verification: 'checking' | 'verified', status: RuntimeStatus | null) => ({
    runtimeStatusByEnvironmentId: new Map([
      [
        'srv',
        runtimeEnvironmentStatusFromSnapshot({
          environmentId: 'srv',
          pairingRevision: 1,
          sequence: 1,
          checkedAt: 1,
          status,
          verification,
          transport: verification === 'verified' ? 'ready' : 'connecting'
        })
      ]
    ])
  })
  useAppStore.setState({
    ...initial,
    repos: [{ ...TEST_REPO, id: 'r1', executionHostId: 'runtime:srv' }],
    worktreesByRepo: { r1: [worktree] },
    ...contact('checking', null)
  })
  const pending = createAgentMenuTerminalPendingSelector({ worktreeId: worktree.id })
  expect(pending(useAppStore.getState())).toBe(true)
  useAppStore.setState(contact('verified', answered && { ...answered, hostPlatform: 'linux' }))
  expect(pending(useAppStore.getState())).toBe(false)
})

/** Copies whose owner-field reads (`id`, `executionHostId`) are counted. */
