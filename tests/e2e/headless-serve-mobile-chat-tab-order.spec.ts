/**
 * #29968: a phone paired straight to a headless `orca serve` keeps a Claude chat tab, in its place
 * in the tab order, while the phone closes and opens terminals around it.
 */
import { randomUUID } from 'node:crypto'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { pairMobileClient } from './helpers/paired-mobile-client'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../src/shared/structured-agent-session-create'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'

test('a headless host keeps the phone its chat tab as terminals come and go', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'mobile' })
  const phone = pairMobileClient(host.offer)
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    let worktreeId = ''
    await expect
      .poll(
        async () => {
          const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
            'worktree.ps',
            { limit: 1_000 }
          )
          worktreeId = worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? ''
          return worktreeId
        },
        { timeout: 30_000 }
      )
      .not.toBe('')
    const worktree = `id:${worktreeId}`
    const { tab: oldTerminal } = await phone.call<{ tab: { parentTabId: string } }>(
      'session.tabs.createTerminal',
      { worktree, clientMutationId: 'old', activate: true, select: true, navigation: 'caller' }
    )
    const sessionId = createStructuredAgentSessionId('claude', randomUUID)
    await phone.call(
      'agentSession.create',
      structuredAgentSessionCreateParams({
        sessionId,
        worktree,
        agent: 'claude',
        randomUuid: randomUUID
      })
    )
    const chatTabId = `agent-session:${sessionId}`

    // The reported sequence: close the old terminal, then a setup terminal opens beside the chat.
    await phone.call('session.tabs.close', {
      worktree,
      tabId: oldTerminal.parentTabId,
      reason: 'user'
    })
    await host.client.call('terminal.create', { worktree, command: 'echo setup' })
    await phone.call('session.tabs.createTerminal', {
      worktree,
      clientMutationId: 'new',
      activate: true,
      select: true,
      navigation: 'caller'
    })

    const listed = await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree
    })
    expect(listed.tabs.map((tab) => tab.id)).toContain(chatTabId)
    expect(listed.tabGroups?.flatMap((group) => group.tabOrder)).toContain(chatTabId)
  } finally {
    await host.dispose()
  }
})
