import { expect, type Page } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../../src/cli/runtime-client'
import type { RuntimeWorktreePsSummary } from '../../../src/shared/runtime-types'

export async function expectRestoredAgentInWorktreeInventory(args: {
  page: Page
  client: RuntimeClient
  ptyId: string
  paneKey: string
  worktreeId: string
  agentType: string
}): Promise<void> {
  const process = await args.page.evaluate(
    (ptyId) => window.api.pty.inspectProcess(ptyId),
    args.ptyId
  )
  expect(process).toEqual({
    foregroundProcess: null,
    hasChildProcesses: false,
    unavailable: true
  })
  await expect
    .poll(async () => {
      const inventory = await args.client.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
        'worktree.ps',
        {
          limit: 10_000,
          supportsWorktreeRestoredAgentPresence: true,
          supportsWorktreeVisibilitySourceDefaults: true
        }
      )
      const summary = inventory.result.worktrees.find(
        (candidate) => candidate.worktreeId === args.worktreeId
      )
      return {
        status: summary?.status,
        agent: summary?.agents.find((agent) => agent.paneKey === args.paneKey)
      }
    })
    .toMatchObject({
      status: 'active',
      agent: {
        paneKey: args.paneKey,
        agentType: args.agentType,
        restoredUnconfirmed: true,
        agentLiveness: 'unverifiable'
      }
    })
}
