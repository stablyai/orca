/**
 * STA-12043: a serve host stopped with its terminal daemon and restored starts a new shell in each
 * pane. That pane's last hook row is the old run's completed turn, so a phone must not see Done
 * beside the new shell, yet must still find the conversation through its provider session. A phone
 * that cannot read unverifiable rows keeps the legacy Done it always received.
 */
import { expect, test } from './helpers/orca-app'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import { pairMobileClient, type PairedMobileClient } from './helpers/paired-mobile-client'
import { emitCodexHookStatus, readHookEndpoint } from './helpers/agent-hook-endpoint'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'

const SESSION_ID = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b'

type PaneStatus = {
  ready: boolean
  state: string | null
  restoredUnconfirmed: boolean
  sessionId: string | null
}

async function readPaneStatus(
  phone: PairedMobileClient,
  worktreeId: string,
  tabId: string
): Promise<PaneStatus | string> {
  const listed = await phone.request<RuntimeMobileSessionTabsResult>('session.tabs.list', {
    worktree: `id:${worktreeId}`
  })
  if (!listed.ok) {
    return `refused:${listed.error.code}`
  }
  const tab = listed.result.tabs.find(
    (candidate) => candidate.type === 'terminal' && candidate.parentTabId === tabId
  )
  if (tab?.type !== 'terminal') {
    return 'missing'
  }
  return {
    ready: tab.status === 'ready',
    state: tab.agentStatus?.state ?? null,
    restoredUnconfirmed: tab.agentStatus?.restoredUnconfirmed === true,
    sessionId: tab.agentStatus?.providerSession?.id ?? null
  }
}

test('a cold-restored serve terminal keeps its agent session without showing Done', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const { host, phone, dispose } = await launchPhoneMirrorTopology(
    { phoneTo: 'host', pinnedServePort: true },
    testInfo
  )
  const legacyPhone = pairMobileClient(host.offer, [])
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
      'worktree.ps',
      { limit: 1_000 }
    )
    const worktreeId = worktrees.find((row) => row.path === testRepoPath)?.worktreeId ?? ''
    expect(worktreeId, 'the phone lists the serve host workspace').not.toBe('')

    const created = await phone.call<{ tab: { id: string; parentTabId: string; leafId: string } }>(
      'session.tabs.createTerminal',
      { worktree: `id:${worktreeId}`, activate: false, select: true, navigation: 'caller' }
    )
    const { parentTabId: tabId, leafId } = created.tab
    const paneKey = `${tabId}:${leafId}`

    const endpoint = await readHookEndpoint(host.app)
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'working',
      prompt: 'say hi',
      sessionId: SESSION_ID
    })
    await emitCodexHookStatus(endpoint, {
      paneKey,
      worktreeId,
      state: 'done',
      lastAssistantMessage: 'hi',
      sessionId: SESSION_ID
    })
    await expect
      .poll(() => readPaneStatus(phone, worktreeId, tabId))
      .toMatchObject({ state: 'done', restoredUnconfirmed: false, sessionId: SESSION_ID })

    // A user opening the tab is the wake gesture that starts or reattaches the restored pane.
    const openTab = () =>
      expect
        .poll(async () => {
          const activated = await phone.request('session.tabs.activate', {
            worktree: `id:${worktreeId}`,
            tabId: created.tab.id,
            navigation: 'caller',
            intent: 'user'
          })
          return activated.ok
        })
        .toBe(true)

    // The daemon kept the shell the turn ran in, so nothing says that turn is gone.
    await host.restartServeProcess()
    await openTab()
    await expect
      .poll(() => readPaneStatus(phone, worktreeId, tabId), { timeout: 60_000 })
      .toMatchObject({ ready: true, state: 'done', restoredUnconfirmed: false })

    // Why the daemon too: a serve restart alone reattaches the same shell; the ticket's host lost it.
    await host.restartServeProcess({ betweenProcesses: () => cleanupE2EDaemons(host.userDataDir) })

    await openTab()
    await expect
      .poll(() => readPaneStatus(phone, worktreeId, tabId), { timeout: 60_000 })
      .toMatchObject({ ready: true, restoredUnconfirmed: true, sessionId: SESSION_ID })
    await expect
      .poll(() => readPaneStatus(legacyPhone, worktreeId, tabId))
      .toMatchObject({ state: 'done', restoredUnconfirmed: false, sessionId: SESSION_ID })
  } finally {
    legacyPhone.dispose()
    await dispose()
  }
})
