// @vitest-environment happy-dom
import { mocks, resetWork } from './agent-menu-rows.test-fixture'
import { act, renderHook } from '@testing-library/react'
import { expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import {
  loadHostStructuredAgents,
  retainHostStructuredAgents
} from '@/runtime/host-structured-agents'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { useNewTabAgentMenuRows } from './use-new-tab-agent-menu-rows'
import {
  STRUCTURED_AGENT_SESSION_AVAILABILITY_RUNTIME_CAPABILITY as AVAILABILITY,
  STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY as CHAT,
  STRUCTURED_AGENT_SESSION_CLIENT_LAUNCH_MODE_CAPABILITY as CLIENT,
  STRUCTURED_AGENT_SESSION_REGISTERED_AGENTS_RUNTIME_CAPABILITY as CATALOG
} from '../../../../shared/protocol-version'
it.each([10, 100])(
  'isolates %s local menu consumers from real peer publications and updates local catalog/failure output linearly',
  async (n) => {
    mocks.realRoutes = mocks.realPublications = true
    mocks.detection.mockReturnValue({ detectedIds: ['claude', 'codex', 'pi', 'gemini'] })
    const localCaps = [CHAT, CLIENT, CATALOG]
    const peerCaps = [...localCaps, AVAILABILITY]
    const peer = `peer-${n}`
    const runtime = createCompatibleRuntimeStatusResponse(`runtime-${n}`).result
    setLocalRuntimeCapabilitiesForTests(localCaps)
    useAppStore.setState({
      repos: [TEST_REPO],
      worktreesByRepo: {
        [TEST_REPO.id]: [makeWorktree({ id: 'one', repoId: TEST_REPO.id, hostId: 'local' })]
      },
      runtimeStatusByEnvironmentId: new Map([
        [peer, { status: { ...runtime, capabilities: peerCaps }, checkedAt: 1 }]
      ]),
      settings: {
        ...getDefaultSettings('/home/me'),
        nativeChatProviders: { claude: true, codex: true, pi: true }
      }
    })
    mocks.call.mockResolvedValue({
      agents: ['claude', 'codex'].map((agent) => ({ agent, capabilities: {} }))
    })
    await loadHostStructuredAgents('local', localCaps, null)
    await loadHostStructuredAgents(`runtime:${peer}`, peerCaps, runtime.runtimeId)
    const renders = Array<number>(n).fill(0)
    const locals = renders.map((_, i) =>
      renderHook(() => {
        renders[i]++
        return useNewTabAgentMenuRows('one', true, { kind: 'local' })
      })
    )
    const remote = renderHook(() =>
      useNewTabAgentMenuRows(
        { workspace: { kind: 'git-worktree', runtimeEnvironmentId: peer } },
        true,
        { kind: 'local' }
      )
    )
    await act(async () => {})
    const output = () => JSON.stringify(locals[0].result.current)
    const initialOutput = output()
    const baseline = [...renders]
    resetWork()
    mocks.catalogReads = 0
    await act(async () => retainHostStructuredAgents(new Set(['local'])))
    expect(renders).toEqual(baseline)
    await act(async () => {
      mocks.call.mockResolvedValue({ agents: [{ agent: 'grok', capabilities: {} }] })
      await loadHostStructuredAgents(`runtime:${peer}`, peerCaps, runtime.runtimeId)
    })
    expect(renders).toEqual(baseline)
    const stream = mocks.subscribe.mock.calls.findLast(([target]) => target.environmentId === peer)
    expect(stream).toBeDefined()
    await act(async () =>
      stream![3].onEvent({
        type: 'availability',
        agents: [{ agent: 'grok', state: 'available', chatProgram: 'available' }]
      })
    )
    expect(renders).toEqual(baseline)
    expect(output()).toBe(initialOutput)
    expect(mocks.routes.length).toBeLessThan(30 * (n + 1))
    expect(mocks.catalogReads).toBeLessThan(100 * (n + 1))
    resetWork()
    mocks.catalogReads = 0
    await act(async () => retainHostStructuredAgents(new Set([`runtime:${peer}`])))
    await act(async () => {
      mocks.call.mockResolvedValue({
        agents: ['claude', 'codex', 'pi'].map((agent) => ({ agent, capabilities: {} }))
      })
      await loadHostStructuredAgents('local', localCaps, null)
    })
    expect(renders.every((count, i) => count > baseline[i])).toBe(true)
    expect(output()).not.toBe(initialOutput)
    expect(
      locals[0].result.current.state === 'settled' && locals[0].result.current.rows
    ).toContainEqual({ kind: 'chat', agent: 'pi', executionHostId: 'local' })
    expect(mocks.routes.length).toBeLessThan(30 * (n + 1))
    expect(mocks.catalogReads).toBeLessThan(100 * (n + 1))
    const learnedOutput = output()
    await act(async () => retainHostStructuredAgents(new Set([`runtime:${peer}`])))
    const unlearnedOutput = output()
    expect(locals[0].result.current.state).toBe('loading')
    const unlearnedRenders = [...renders]
    resetWork()
    mocks.catalogReads = 0
    const failedReads = mocks.call.mock.calls.length
    await act(async () => {
      mocks.call.mockRejectedValue(new Error('catalog read failed'))
      await loadHostStructuredAgents('local', localCaps, null)
    })
    expect(output()).not.toBe(learnedOutput)
    expect(output()).not.toBe(unlearnedOutput)
    expect(renders.every((count, i) => count > unlearnedRenders[i])).toBe(true)
    expect(locals[0].result.current.state).toBe('settled')
    expect(
      locals[0].result.current.state === 'settled' && locals[0].result.current.rows
    ).toContainEqual({ kind: 'cli', agent: 'gemini', executionHostId: 'local' })
    expect(mocks.call).toHaveBeenCalledTimes(failedReads + 1)
    expect(mocks.routes.length).toBeLessThan(30 * (n + 1))
    expect(mocks.catalogReads).toBeLessThan(100 * (n + 1))
    console.info('publication contract', {
      n,
      routes: mocks.routes.length,
      catalogReads: mocks.catalogReads,
      renders: renders[0]
    })
    locals.forEach((hook) => hook.unmount())
    remote.unmount()
  }
)
