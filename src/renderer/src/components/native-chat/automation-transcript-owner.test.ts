import { expect, it, vi } from 'vitest'
import { captureNativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'
import { automationOpenFromCard } from './native-chat-automation-open'
import { openBotAutomation } from '../bots/bot-automation-open'

const fixture = vi.hoisted(
  (): {
    revision: number
    continued: boolean
    pending: unknown
    state: { runtimeEnvironments: { id: string; createdAt: number; pairingRevision: number }[] }
  } => ({
    revision: 7,
    continued: false,
    pending: null,
    state: { runtimeEnvironments: [{ id: 'env-1', createdAt: 1, pairingRevision: 7 }] }
  })
)
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      ...fixture.state,
      setPendingAutomationRunNavigation: (pending: unknown) => {
        fixture.pending = pending
      },
      openAutomationsPage: () => undefined
    })
  }
}))
vi.mock('@/lib/bot-catalog', () => ({ openBotHome: () => true }))
vi.mock('@/lib/bot-catalog-snapshot', () => ({ readHostBots: () => [] }))
vi.mock('@/components/native-chat/pane/ownership/use-native-chat-tab-owner', () => ({
  useNativeChatTabOwnerWorktreeId: () => null
}))
vi.mock('@/app-shell/platform/paired-web-client-host', () => ({
  getPairedWebClientEnvironmentId: () => null
}))
vi.mock('sonner', () => ({ toast: { error: () => undefined } }))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => fixture.revision,
  isRuntimeEnvironmentContinuationPending: () => false,
  resolveContinuedRuntimeEnvironmentRevision: (_id: string, captured: number) =>
    fixture.continued ? fixture.revision : captured
}))

it('keeps transcript navigation bound to its original owner across replacement and permits proven continuation', () => {
  const owner = captureNativeChatVisualOwner(
    { kind: 'environment', environmentId: 'env-1' },
    'chat-1',
    'workspace-1'
  )
  fixture.revision = 8
  fixture.state.runtimeEnvironments[0].pairingRevision = 8
  const open = automationOpenFromCard(owner, { id: 'a1', bot: { botId: 'b1' } }, 'r1', 'page')
  expect(open.owner).toEqual({
    authority: { kind: 'runtime', environmentId: 'env-1', pairingRevision: 7 },
    selector: { kind: 'self' }
  })
  openBotAutomation(open)
  expect(fixture.pending).toBeNull()
  fixture.continued = true
  openBotAutomation(open)
  expect(fixture.pending).toEqual({ automationId: 'a1', runId: 'r1', hostId: 'runtime:env-1' })
})
