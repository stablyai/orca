// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatSkillDiscovery } from './use-native-chat-skills'
import type { SkillDiscoveryResult } from '../../../../../../shared/skills'

const paneContext = {
  key: 'pane-1',
  cwd: '/repo/worktree',
  executionHostKind: 'local' as const,
  runtimeTarget: { kind: 'local' as const },
  discoveryTarget: { cwd: '/repo/worktree', worktreeId: 'worktree-1' }
}

const mocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  snapshots: [] as NativeChatSkillDiscovery[]
}))

vi.mock('../../../../store/index', () => ({
  useAppStore: (selector: (state: { open: true }) => unknown) => selector({ open: true })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (...args: unknown[]) => mocks.callRuntimeRpc(...args)
}))
vi.mock('@/components/native-chat/telemetry/native-chat-telemetry', () => ({
  emitNativeChatSkillDiscovery: vi.fn()
}))
vi.mock('./native-chat-skill-discovery-context', () => ({
  selectNativeChatSkillStateInputs: (state: { open: true }) => state,
  isNativeChatSkillDiscoveryAwaitingDirectory: () => false,
  resolveNativeChatSkillDiscoveryContext: () => paneContext
}))

import {
  resetNativeChatSkillDiscoveryCacheForTests,
  useNativeChatSkills
} from './use-native-chat-skills'

function discoveryPayload(name: string, scannedAt: number): SkillDiscoveryResult {
  return {
    skills: [
      {
        id: name,
        name,
        description: null,
        providers: ['agent-skills'],
        sourceKind: 'home',
        sourceLabel: 'Agent skills home',
        rootPath: '/home/test/.agents/skills',
        directoryPath: `/home/test/.agents/skills/${name}`,
        skillFilePath: `/home/test/.agents/skills/${name}/SKILL.md`,
        installed: true,
        updatedAt: null
      }
    ],
    sources: [
      {
        id: 'home-agents',
        label: 'Agent skills home',
        path: '/home/test/.agents/skills',
        sourceKind: 'home',
        providers: ['agent-skills'],
        owner: null,
        exists: true
      }
    ],
    scannedAt
  }
}

function Probe({ enabled }: { enabled: boolean }): null {
  mocks.snapshots.push(useNativeChatSkills('codex', 'tab-1', enabled))
  return null
}

describe('useNativeChatSkills', () => {
  beforeEach(() => {
    mocks.snapshots = []
    mocks.callRuntimeRpc.mockReset()
    mocks.callRuntimeRpc.mockResolvedValue(discoveryPayload('browser', 1))
    resetNativeChatSkillDiscoveryCacheForTests()
  })

  afterEach(() => cleanup())

  it('asks the runtime again when the picker closes and reopens', async () => {
    const view = render(<Probe enabled />)
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.snapshots.at(-1)?.skills.map((skill) => skill.name)).toEqual(['browser'])
    const callsAfterOpen = mocks.callRuntimeRpc.mock.calls.length

    mocks.callRuntimeRpc.mockResolvedValue(discoveryPayload('fresh', 2))
    view.rerender(<Probe enabled={false} />)
    expect(mocks.snapshots.at(-1)?.status).toBe('idle')

    view.rerender(<Probe enabled />)
    await waitFor(() =>
      expect(mocks.snapshots.at(-1)?.skills.map((skill) => skill.name)).toEqual(['fresh'])
    )
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(callsAfterOpen + 1)
  })

  it('drops a scan that finishes after the picker has closed', async () => {
    let resolveFirst: (value: SkillDiscoveryResult) => void = () => {}
    mocks.callRuntimeRpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve
        })
    )
    const view = render(<Probe enabled />)
    expect(mocks.snapshots.at(-1)?.status).toBe('loading')

    view.rerender(<Probe enabled={false} />)
    resolveFirst(discoveryPayload('stale', 1))
    await Promise.resolve()

    mocks.callRuntimeRpc.mockResolvedValue(discoveryPayload('fresh', 2))
    view.rerender(<Probe enabled />)
    await waitFor(() =>
      expect(mocks.snapshots.at(-1)?.skills.map((skill) => skill.name)).toEqual(['fresh'])
    )
    expect(mocks.callRuntimeRpc.mock.calls.length).toBeGreaterThan(1)
  })

  it('shares one in-flight request between open pickers', async () => {
    render(
      <>
        <Probe enabled />
        <Probe enabled />
      </>
    )
    await waitFor(() => expect(mocks.snapshots.at(-1)?.status).toBe('ready'))
    expect(mocks.callRuntimeRpc).toHaveBeenCalledTimes(1)
  })
})
