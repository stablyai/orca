// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import {
  automationOwnerBot,
  automationOwnerEnvironment
} from '../automations/hosts/automation-owner.test-fixture'
import { botAutomationOriginCurrent } from '../automations/hosts/bot-automation-row-owner'
import { openBotSession } from './bot-session-open'
import { openOrchestrationWorker } from '@/lib/open-orchestration-worker'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'

vi.mock('@/runtime/rpc/compatibility/runtime-compatibility-probe', () => ({
  ensureRuntimeEnvironmentCompatible: async () => null,
  getRuntimeEnvironmentStatus: async () => createCompatibleRuntimeStatusResponse('origin').result
}))
vi.mock('@/lib/bot-catalog', () => ({
  openBotHomeTab: async () => false,
  openBotHome: () => false
}))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))
vi.mock('@/lib/bot-group-catalog', () => ({ openBotGroupRoom: async () => undefined }))
vi.mock('@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-log-open', () => ({
  openAiVaultSessionLogInOrca: async () => false
}))
vi.mock(
  '@/components/right-sidebar/ai-vault/session-actions/ai-vault-session-path-actions',
  () => ({ canOpenAiVaultSessionLogInOrca: () => false })
)
vi.mock('@/components/native-chat-recovery/offers/native-chat-restart-runtimes', () => ({
  nativeChatRestartStillStarting: () => false
}))
const feedback = vi.hoisted((): { retry: (() => void) | null } => ({ retry: null }))
vi.mock('@/lib/agent-session/open/chat-open-failure-toast', () => ({
  showChatOpenUnavailable: (value: { retry?: () => void }) => {
    feedback.retry = value.retry ?? null
  }
}))
afterEach(() => {
  feedback.retry = null
})
beforeEach(() =>
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { runtime: {}, runtimeEnvironments: {} }
  })
)
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const bot = automationOwnerBot('runtime:e')
const owner = {
  authority: { kind: 'runtime', environmentId: 'e', pairingRevision: 1 },
  selector: { kind: 'self' }
} as const
const tab: Tab = {
  id: 'agent-session:chat',
  entityId: 'chat',
  worktreeId: 'folder:same',
  executionHostId: 'runtime:e',
  contentType: 'agent-session',
  label: 'Chat',
  groupId: 'g',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

function setOwner(revision: number, continuation = false): void {
  const environment = automationOwnerEnvironment('e', revision)
  replaceRuntimeEnvironmentRevisions([environment], {
    retired: continuation ? [] : ['e'],
    sameHost: continuation ? [{ id: 'e', fromRevision: 1, toRevision: revision }] : []
  })
  useAppStore.setState({ runtimeEnvironments: [environment] })
}

it.each(['session.tabs.list', 'orchestration.partyLocation', 'agentSession.reveal'] as const)(
  'carries a panel chat origin through held %s and permits only proven continuation',
  async (heldMethod) => {
    for (const continuation of [false, true]) {
      setOwner(1)
      useAppStore.setState({
        activeView: 'terminal',
        activeWorktreeId: 'folder:same',
        activeWorkspaceExecutionHostId: 'runtime:e',
        unifiedTabsByWorktree: {},
        groupsByWorktree: {
          'folder:same': [
            {
              id: 'g',
              worktreeId: 'folder:same',
              activeTabId: 'before',
              tabOrder: ['before', tab.id]
            }
          ]
        }
      })
      let release!: () => void
      let entered!: () => void
      const held = new Promise<void>((resolve) => {
        release = resolve
      })
      const ready = new Promise<void>((resolve) => {
        entered = resolve
      })
      const calls: string[] = []
      window.api.runtimeEnvironments = {
        ...window.api.runtimeEnvironments,
        call: async (request) => {
          if (request.method === 'status.get') {
            return createCompatibleRuntimeStatusResponse('origin')
          }
          calls.push(request.method)
          if (request.method === heldMethod) {
            entered()
            await held
          }
          const result =
            request.method === 'orchestration.partyLocation'
              ? { location: { kind: 'chat', sessionId: 'chat', worktreeId: 'folder:same' } }
              : request.method === 'agentSession.reveal'
                ? { ok: true, sessionId: 'chat', workspaceId: 'folder:same', agent: 'codex' }
                : {}
          return { id: 'fixture', _meta: { runtimeId: 'origin' }, ok: true, result }
        }
      }
      openBotSession(bot, 'chat', 'folder:same', botAutomationOriginCurrent(owner, bot))
      await ready
      setOwner(2, continuation)
      useAppStore.setState({ unifiedTabsByWorktree: { 'folder:same': [tab] } })
      release()
      for (let index = 0; index < 8; index++) {
        await flush()
      }
      expect(calls.includes('session.tabs.activate')).toBe(continuation)
      expect(calls.includes('bots.chats.seen')).toBe(continuation)
      expect(useAppStore.getState().groupsByWorktree['folder:same'][0].activeTabId).toBe(
        continuation ? tab.id : 'before'
      )
    }
  }
)

it('keeps the worker dispatcher Retry bound to its captured origin', async () => {
  setOwner(1)
  useAppStore.setState({ unifiedTabsByWorktree: {} })
  let calls = 0
  window.api.runtimeEnvironments = {
    ...window.api.runtimeEnvironments,
    call: async () => {
      calls++
      throw new Error('offline')
    }
  }
  openOrchestrationWorker(
    { title: 'Worker', dispatchId: 'dispatch', worktreeId: 'folder:same', chatSessionId: null },
    { kind: 'environment', environmentId: 'e' },
    botAutomationOriginCurrent(owner, bot)
  )
  for (let index = 0; index < 8; index++) {
    await flush()
  }
  expect(feedback.retry).not.toBeNull()
  const firstCalls = calls
  setOwner(2)
  feedback.retry?.()
  for (let index = 0; index < 8; index++) {
    await flush()
  }
  expect(calls).toBe(firstCalls)
})
