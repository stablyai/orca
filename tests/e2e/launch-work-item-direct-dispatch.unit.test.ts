import { directDiscoveryProbe } from './launch-work-item-direct-discovery.test-fixture'
import { directWorkItemProjectFixture } from '@/lib/launch-work-item-direct-project.test-fixture'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PreflightRuntimeContext } from '../../src/main/ipc/preflight-runtime-target'
import { useAppStore } from '@/store'
import { RUNTIME_CAPABILITIES } from '../../src/shared/protocol-version'
import * as localCapabilities from '@/runtime/local-runtime-capabilities'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import type * as NewWorkspace from '@/lib/new-workspace'
import {
  detectAgentsOnHost,
  detectProjectLaunchContext
} from '../../src/main/preflight/workspace-agent-detection'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent.test-fixture'
import { launchWorkItemDirect } from '@/lib/launch-work-item-direct'
import { createDeferred } from '@/components/terminal-pane/pty-connection-test-async'
import { buildPaneConnectionDeps } from '@/components/terminal-pane/pty-connection-test-deps'
import {
  createPane,
  createManager
} from '@/components/terminal-pane/pty-connection-test-pane-fixtures'
import { connectMockPanePty } from '@/components/terminal-pane/pty-connection-test-connect-mock-pane'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from '@/components/terminal-pane/pty-connection-test-environment'
import { installIpcPtyWindow } from '@/components/terminal-pane/pty-transport-test-harness'
import { createQueuedStartupConsumer } from '@/components/terminal-pane/terminal-pane-lifecycle-primitives'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => {
  const { runtimeRpcClientWithLayoutApply } =
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  const actual = runtimeRpcClientWithLayoutApply(await importOriginal<typeof RuntimeRpcClient>())
  return { ...actual, callRuntimeRpc: vi.fn(actual.callRuntimeRpc) }
})
vi.mock('@/runtime/runtime-hooks-client', () => ({
  checkRuntimeHooks: vi.fn(async () => ({ hooks: null }))
}))
vi.mock('@/lib/new-workspace', async (importOriginal) => ({
  ...(await importOriginal<typeof NewWorkspace>()),
  CLIENT_PLATFORM: 'win32'
}))

const initial = useAppStore.getInitialState()
const platform = process.platform
const bindings: Awaited<ReturnType<typeof connectMockPanePty>>[] = []

beforeEach(async () => {
  useAppStore.setState(initial, true)
  useAppStore.getState().clearLocalDetectedAgents()
  Object.defineProperty(process, 'platform', { value: 'win32' })
  await installTerminalTestGlobals()
  installIpcPtyWindow(window, {})
  vi.spyOn(localCapabilities, 'ensureLocalRuntimeCapabilities').mockResolvedValue(
    RUNTIME_CAPABILITIES
  )
  directDiscoveryProbe().mockResolvedValue({
    environmentResolved: false,
    code: 0,
    stdout: '',
    timedOut: false
  })
})

afterEach(async () => {
  bindings.splice(0).forEach((binding) => binding.dispose())
  await restoreTerminalTestGlobals()
  Object.defineProperty(process, 'platform', { value: platform })
  useAppStore.getState().clearLocalDetectedAgents()
  useAppStore.setState(initial, true)
})

it.each(['blank', 'claude'] as const)(
  'direct %s reaches one WSL spawn and settles after exact-target discovery failure',
  async (choice) => {
    const worktree = makeCreatedAgentWorktree()
    seedEmptyActivatableWorktree(worktree)
    const project = directWorkItemProjectFixture()
    const settings = {
      ...useAppStore.getState().settings!,
      defaultTuiAgent: choice,
      agentDefaultSurface: 'terminal' as const,
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' } as const
    }
    const createWorktree = vi.fn(async () => ({ worktree, setup: undefined }))
    useAppStore.setState({ ...project, settings, createWorktree })
    const host = {
      getRepos: () => [...project.repos],
      getRepo: () => project.repos[0],
      getProjects: () => [...project.projects],
      getSettings: () => settings
    }
    vi.mocked(callRuntimeRpc).mockImplementationOnce(async () =>
      detectProjectLaunchContext(host, project.repos[0])
    )
    Object.assign(window.api, {
      preflight: {
        detectAgents: (context: PreflightRuntimeContext) =>
          detectAgentsOnHost({ kind: 'local', context })
      }
    })
    await useAppStore.getState().ensureDetectedAgents(worktree.id)
    const fallback = vi.fn()
    expect(
      await launchWorkItemDirect({
        repoId: 'repo-1',
        launchSource: 'task_page',
        openModalFallback: fallback,
        ...(choice === 'claude' ? { agentOverride: choice, agentArgs: '--model sonnet' } : {}),
        item: {
          type: 'issue',
          number: 42,
          title: 'Fix',
          url: 'https://github.com/acme/repo/issues/42'
        }
      })
    ).toBe(true)
    expect(createWorktree).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
    expect(useAppStore.getState().readLocalAgentInventory(worktree.id).state).toBe('failed')
    const tabs = useAppStore.getState().tabsByWorktree[worktree.id]
    expect(tabs).toHaveLength(1)
    const tab = tabs[0]
    const startup = useAppStore.getState().pendingStartupByTabId[tab.id]
    const deps = buildPaneConnectionDeps(
      () => {
        throw new Error('Use production store bindings')
      },
      {
        tabId: tab.id,
        worktreeId: worktree.id,
        cwd: worktree.path,
        startup,
        updateTabPtyId: useAppStore.getState().updateTabPtyId,
        syncPanePtyLayoutBinding: vi.fn(),
        onQueuedStartupSpawned: createQueuedStartupConsumer(
          startup,
          startup,
          () => useAppStore.getState().consumeTabStartupCommand(tab.id),
          () => useAppStore.getState().pendingStartupByTabId[tab.id] === startup
        )
      }
    )
    const spawn = createDeferred<{ id: string }>()
    vi.mocked(window.api.pty.spawn).mockReturnValueOnce(spawn.promise)
    bindings.push(await connectMockPanePty(createPane(1), createManager(1), deps))
    await vi.waitFor(() => expect(window.api.pty.spawn).toHaveBeenCalledOnce())
    expect(useAppStore.getState().tabsByWorktree[worktree.id][0].ptyId).toBeNull()
    expect(useAppStore.getState().pendingStartupByTabId[tab.id]).toBe(startup)
    spawn.resolve({ id: 'pty-1' })
    await vi.waitFor(() =>
      expect(useAppStore.getState().tabsByWorktree[worktree.id][0].ptyId).toBe('pty-1')
    )
    expect(window.api.pty.spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        worktreeId: worktree.id,
        cwd: worktree.path,
        projectRuntime: expect.objectContaining({
          runtime: expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu' })
        }),
        command:
          choice === 'blank'
            ? undefined
            : "claude '--model' 'sonnet' --prefill 'https://github.com/acme/repo/issues/42'",
        ...(choice === 'claude'
          ? {
              launchAgent: 'claude',
              launchConfig: expect.objectContaining({ agentArgs: '--model sonnet' })
            }
          : {})
      })
    )
    expect(useAppStore.getState().pendingStartupByTabId[tab.id]).toBeUndefined()
    expect(deps.onPtyErrorRef.current).not.toHaveBeenCalled()
  }
)
