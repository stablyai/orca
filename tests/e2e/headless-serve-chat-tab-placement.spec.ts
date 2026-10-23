/**
 * L270: a switch-on `orca serve` saves a chat a paired client creates where the client asked
 * (`tabPlacement`, in the server's own group and tab ids), not at the end of the group.
 *
 * Run (switch-on build: ORCA_LAYOUT_OWNER=main ... --mode e2e):
 *   pnpm exec playwright test tests/e2e/headless-serve-chat-tab-placement.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY } from '../../src/shared/agent-session-create-capabilities'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../src/shared/structured-agent-session-create'
import { structuredAgentSessionTabId } from '../../src/shared/structured-agent-session-projection'
import { HOST_TERMINAL_SURFACE_SEPARATOR } from '../../src/shared/terminal-surface-id'
import { expect, test } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { readServerLayout } from './helpers/paired-desktop-server-layout'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

test.describe('a chat a paired client creates lands where it asked', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')

  test('between two terminals, after the one the client named', async ({ testRepoPath }) => {
    test.setTimeout(180_000)
    const host = await launchHeadlessPairedRuntimeHost()
    try {
      const status = await host.client.call<{ capabilities?: string[] }>('status.get')
      expect(status.result.capabilities ?? []).toContain(
        AGENT_SESSION_CREATE_TAB_PLACEMENT_RUNTIME_CAPABILITY
      )
      const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: testRepoPath,
        kind: 'folder'
      })
      let worktreeId = ''
      await expect
        .poll(async () => {
          const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
            repo: `id:${added.result.repo.id}`
          })
          return (worktreeId = listed.result.worktrees[0]?.id ?? '')
        })
        .not.toBe('')
      const worktree = `id:${worktreeId}`
      const terminal = async (): Promise<string> => {
        const created = await host.client.call<{ tab: { id: string } }>(
          'session.tabs.createTerminal',
          { worktree, activate: false, select: false, navigation: 'caller' }
        )
        return created.result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
      }
      const first = await terminal()
      const second = await terminal()
      let groupId = ''
      await expect
        .poll(async () => {
          const group = (await readServerLayout(host, worktreeId))?.groups.find(
            (entry) => entry.tabIds.includes(first) && entry.tabIds.includes(second)
          )
          groupId = group?.id ?? ''
          return group?.tabIds.filter((id) => id === first || id === second)
        })
        .toEqual([first, second])

      const sessionId = createStructuredAgentSessionId('claude', randomUUID)
      await host.client.call(
        'agentSession.create',
        structuredAgentSessionCreateParams({
          sessionId,
          worktree,
          agent: 'claude',
          tabPlacement: { groupId, afterTabId: first },
          randomUuid: randomUUID
        })
      )

      const chatTabId = structuredAgentSessionTabId(sessionId)
      await expect
        .poll(
          async () =>
            (await readServerLayout(host, worktreeId))?.groups
              .find((entry) => entry.id === groupId)
              ?.tabIds.filter((id) => id === first || id === second || id === chatTabId),
          { timeout: 30_000, message: 'The chat never landed after the terminal the client named' }
        )
        .toEqual([first, chatTabId, second])
    } finally {
      await host.dispose()
    }
  })
})
