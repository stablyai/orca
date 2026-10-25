import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import type * as SharedLaunchRoute from '../../src/shared/structured-native-chat-launch-route'
import { decideWorkerStartMode } from '../../src/main/runtime/rpc/methods/orchestration-worker-start-mode'
import {
  resolveAgentLaunchRoute,
  structuredAgentLaunchSupported,
  type AgentLaunchRoutingInput
} from '../../src/renderer/src/lib/agent-launch-routing'
import { RUNTIME_CAPABILITIES } from '../../src/shared/protocol-version'
import {
  resolveStructuredNativeChatSupport,
  type StructuredNativeChatBlocker
} from '../../src/shared/structured-native-chat-launch-route'

vi.mock('../../src/shared/structured-native-chat-launch-route', async (importOriginal) => {
  const actual = await importOriginal<typeof SharedLaunchRoute>()
  return {
    ...actual,
    resolveStructuredNativeChatSupport: vi.fn(actual.resolveStructuredNativeChatSupport)
  }
})

const settings = {
  experimentalNativeChat: true,
  experimentalStructuredNativeChat: true,
  openAgentTabsInChatByDefault: true
}
const predicate = vi.mocked(resolveStructuredNativeChatSupport)
afterEach(() => predicate.mockReset())

const placements = [
  {},
  { on: 'server-1' },
  { on: 'local' },
  { terminal: 'term_1' },
  { worktree: 'current' },
  { worktree: 'new-child' },
  { worktree: 'new-top-level' },
  { model: 'opus', effort: 'high' },
  { worktree: 'new-child', model: 'opus', effort: 'high' }
]
const blockers: StructuredNativeChatBlocker[] = [
  'reused-terminal',
  'agent-without-structured-session',
  'custom-start-directory',
  'remote-execution-host',
  'project-runtime',
  'runtime-capability',
  'runtime-capability-unknown'
]

describe('shared feasibility owns every caller decision', () => {
  it.each(placements.filter((placement) => !('on' in placement)))(
    'orchestration cannot override the shared verdict for %j',
    (placement) => {
      for (const agent of ['claude', 'codex', 'grok', 'openclaude'] as const) {
        for (const customized of [false, true]) {
          // Arguments and environment are customized on BOTH passes and the launch command on one;
          // none of them reaches the verdict. A caller that resumed reading any of them fails here.
          const launchSettings: Partial<GlobalSettings> & typeof settings = {
            ...settings,
            agentDefaultArgs: { [agent]: '--custom' },
            agentDefaultEnv: { [agent]: { ORCA_ROUTING_AUTHORITY: '1' } },
            ...(customized ? { agentCmdOverrides: { [agent]: `${agent}-wrapper` } } : {})
          }
          const input = { params: { agent, ...placement }, settings: launchSettings }
          predicate.mockReturnValue({ supported: true })
          expect(decideWorkerStartMode(input).mode).toBe('structured')
          expect(predicate).toHaveBeenLastCalledWith(
            expect.objectContaining({
              agent,
              executionHostId: 'local',
              reusesTerminal: Boolean(placement.terminal),
              startsOutsideWorkspaceRoot: false
            })
          )
          for (const blocker of blockers) {
            predicate.mockReturnValue({ supported: false, blocker })
            const receipt = decideWorkerStartMode(input)
            expect(receipt).toMatchObject({ mode: 'terminal', preferred: 'structured' })
            expect(receipt.reason).not.toBe('user_default')
            expect(receipt.detail).toContain('Your default is a structured chat session')
            if (blocker === 'runtime-capability-unknown') {
              expect(receipt.reason).toBe('structured_support_unknown')
              expect(receipt.detail).toContain('has not established')
            }
          }
        }
      }
    }
  )

  // A worker placed on another runtime starts through federation, which creates terminal agents
  // only, so that runtime is never asked; the shared verdict is not this host's to give for it.
  it.each(placements.filter((placement) => 'on' in placement))(
    'places a worker on another runtime as a terminal agent for %j',
    (placement) => {
      predicate.mockReturnValue({ supported: true })
      const receipt = decideWorkerStartMode({ params: { agent: 'claude', ...placement }, settings })
      expect(receipt).toMatchObject({
        mode: 'terminal',
        preferred: 'structured',
        reason: 'remote_execution_host'
      })
      expect(predicate).not.toHaveBeenCalled()
    }
  )

  it('renderer presentation cannot override shared feasibility', () => {
    for (const agent of ['claude', 'codex', 'grok', 'openclaude'] as const) {
      for (const executionHostId of ['local', 'ssh:host-1']) {
        for (const promptDelivery of ['auto-submit', 'draft'] as const) {
          const input: AgentLaunchRoutingInput = {
            settings,
            agent,
            executionHostId,
            promptDelivery,
            hostCapabilities: RUNTIME_CAPABILITIES,
            startsOutsideWorkspaceRoot: true,
            workspaceKind: 'folder'
          }
          predicate.mockReturnValue({ supported: true })
          expect(resolveAgentLaunchRoute(input)).toBe('structured-native-chat')
          expect(structuredAgentLaunchSupported(input)).toBe(true)
          expect(predicate).toHaveBeenLastCalledWith(
            expect.objectContaining({
              agent,
              executionHostId,
              startsOutsideWorkspaceRoot: true,
              workspaceKind: 'folder'
            })
          )
          // Why: delivery mode is prompt metadata, never a feasibility input.
          expect(predicate).toHaveBeenLastCalledWith(
            expect.not.objectContaining({ isDraftPrompt: expect.anything() })
          )
          for (const blocker of blockers) {
            predicate.mockReturnValue({ supported: false, blocker })
            expect(resolveAgentLaunchRoute(input)).not.toBe('structured-native-chat')
            expect(structuredAgentLaunchSupported(input)).toBe(false)
          }
        }
      }
    }
  })
})
