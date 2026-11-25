import { beforeEach, expect, it, vi } from 'vitest'
import { automationOwnerBot } from '@/components/automations/hosts/automation-owner.test-fixture'
import type { AutomationOwnerRef } from '../../../shared/automations/ownership/automation-owner-ref'
import {
  automationOwnerForHostId,
  evaluateAutomationOwner
} from '@/components/automations/hosts/automation-host-owner'

const bridge = vi.hoisted(() => ({
  call: vi.fn(),
  refresh: vi.fn(),
  folders: vi.fn(),
  activate: vi.fn(),
  tab: vi.fn(),
  draft: vi.fn(),
  revision: 1,
  checking: false
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      runtimeEnvironments: [{ id: 'e', createdAt: 1, pairingRevision: bridge.revision }],
      fetchFolderWorkspaces: bridge.folders
    })
  }
}))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => bridge.revision,
  resolveContinuedRuntimeEnvironmentRevision: (_id: string, rev: number) => rev,
  isRuntimeEnvironmentContinuationPending: () => bridge.checking
}))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: bridge.call }))
vi.mock('./bot-host-refresh', () => ({ refreshBotHost: bridge.refresh }))
vi.mock('./workspace/activation/worktree-activation', () => ({
  activateAndRevealFolderWorkspace: bridge.activate
}))
vi.mock('./agent-session/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: bridge.tab,
  activateStructuredAgentSessionTabOnOwner: bridge.tab
}))
vi.mock('@/components/native-chat/drafts/native-chat-draft-views', () => ({
  appendNativeChatDraftCache: bridge.draft
}))
vi.mock('../components/native-chat/composer/focus/native-chat-composer-focus-intent', () => ({
  requestNativeChatComposerFocus: vi.fn()
}))
import { openBotHomeTab } from './bot-catalog'

const bot = automationOwnerBot('runtime:e', { folderWorkspaceId: 'home' })
const owner: AutomationOwnerRef = {
  authority: { kind: 'runtime', environmentId: 'e', pairingRevision: 1 },
  selector: { kind: 'self' }
}
function hold<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
beforeEach(() => {
  vi.clearAllMocks()
  bridge.revision = 1
  bridge.checking = false
  bridge.call.mockResolvedValue({ sessionId: 'home-chat' })
  bridge.refresh.mockResolvedValue(undefined)
  bridge.folders.mockResolvedValue(undefined)
  bridge.activate.mockReturnValue(true)
  bridge.tab.mockReturnValue(true)
})

it.each(['foreign', 'checking'] as const)(
  'refuses an initially %s definition without opening or drafting',
  async (kind) => {
    const botId = kind === 'foreign' ? 'other' : 'b'
    bridge.revision = kind === 'checking' ? 2 : 1
    bridge.checking = kind === 'checking'
    const canContinue = () => evaluateAutomationOwner(owner).status === 'same' && botId === bot.id
    expect(await openBotHomeTab(bot, { draft: 'Change it', canContinue })).toBe(false)
    expect(bridge.call).not.toHaveBeenCalled()
    expect(bridge.activate).not.toHaveBeenCalled()
    expect(bridge.draft).not.toHaveBeenCalled()
  }
)

it.each(['call', 'refresh', 'folders'] as const)(
  'rechecks the captured definition and owner after the held %s await',
  async (stage) => {
    for (const change of ['replacement', 'foreign']) {
      vi.clearAllMocks()
      bridge.revision = 1
      let botId = 'b'
      bridge.call.mockResolvedValue({ sessionId: 'home-chat' })
      bridge.refresh.mockResolvedValue(undefined)
      bridge.folders.mockResolvedValue(undefined)
      const wait = hold<unknown>()
      bridge[stage].mockReturnValueOnce(wait.promise)
      const canContinue = () => {
        const continuity = evaluateAutomationOwner(owner)
        const target = automationOwnerForHostId(bot.hostId, {
          runtimeEnvironments: [{ id: 'e', createdAt: 1, pairingRevision: bridge.revision }]
        })
        return (
          continuity.status === 'same' &&
          JSON.stringify(target) === JSON.stringify(owner) &&
          botId === bot.id
        )
      }
      const opening = openBotHomeTab(bot, { draft: 'Change it', canContinue })
      await vi.waitFor(() => expect(bridge[stage]).toHaveBeenCalled())
      if (change === 'replacement') {
        bridge.revision = 2
      } else {
        botId = 'other'
      }
      wait.resolve(stage === 'call' ? { sessionId: 'home-chat' } : undefined)
      expect(await opening).toBe(false)
      expect(bridge.activate).not.toHaveBeenCalled()
      expect(bridge.tab).not.toHaveBeenCalled()
      expect(bridge.draft).not.toHaveBeenCalled()
    }
  }
)

it('activates and drafts once when the same captured owner remains eligible through all awaits', async () => {
  expect(
    await openBotHomeTab(bot, {
      draft: 'Change it',
      canContinue: () => evaluateAutomationOwner(owner).status === 'same'
    })
  ).toBe(true)
  expect(bridge.activate).toHaveBeenCalledTimes(1)
  expect(bridge.tab).toHaveBeenCalledTimes(1)
  expect(bridge.draft.mock.calls).toEqual([['agent-session:home-chat', 'Change it']])
})
