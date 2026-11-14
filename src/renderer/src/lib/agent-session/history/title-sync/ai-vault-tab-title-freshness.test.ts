import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeState } from './ai-vault-tab-title-test-fixture'

import { settleAiVaultTitleRequestBatches } from './ai-vault-tab-title-batches'
import { collectAiVaultTitleRequests } from './ai-vault-tab-title-requests'
import type * as MountedTerminalTabRegistry from '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry'
import type * as TitleRequests from './ai-vault-tab-title-requests'

vi.mock('./ai-vault-tab-title-requests', async (importOriginal) => {
  const actual = await importOriginal<typeof TitleRequests>()
  return { ...actual, collectAiVaultTitleRequests: vi.fn(actual.collectAiVaultTitleRequests) }
})

vi.mock(
  '@/runtime/hosted-terminals/mounted-surfaces/mounted-terminal-tab-registry',
  async (importOriginal) => ({
    ...(await importOriginal<typeof MountedTerminalTabRegistry>()),
    findRegisteredTerminalTab: () => ({
      tab: {
        getManager: () => ({
          getNumericIdForLeaf: (leafId: string) =>
            leafId === '00000000-0000-4000-8000-000000000001' ? 7 : 8
        })
      }
    })
  })
)
afterEach(() => {
  vi.useRealTimers()
})
function storeFor(executionHostId: 'local' | 'runtime:server-1') {
  return makeState({
    executionHostId,
    worktreeId: 'worktree-1',
    path: '/workspace/albacore',
    aiVaultTitle: { agent: 'codex', sessionId: 'codex-session', title: 'First name' }
  })
}

describe('session title freshness', () => {
  it('drops a queued batch whose tab closed while the first batch ran', async () => {
    const store = storeFor('local')
    const request = collectAiVaultTitleRequests(store.getState())[0]!
    const requests = Array.from({ length: 65 }, (_, i) => ({
      ...request,
      tabId: `tab-${i}`,
      paneKey: `tab-${i}:00000000-0000-4000-8000-000000000001`
    }))
    let current = requests
    const sent: string[] = []
    await settleAiVaultTitleRequestBatches(
      requests,
      async (batch) => {
        sent.push(...batch.map((entry) => entry.tabId))
        current = requests.slice(0, 64)
      },
      () => current
    )
    expect(sent).not.toContain('tab-64')
    expect(sent).toHaveLength(64)
  })
})
