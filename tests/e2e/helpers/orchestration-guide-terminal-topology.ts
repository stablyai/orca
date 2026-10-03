/**
 * The terminals the guide-contract spec addresses, and how to keep addressing
 * them across a restart.
 *
 * The PTY outlives the app but the handle minted for it may not, so anything
 * that has to survive a relaunch is tracked by `ptyId` and re-resolved. Pane
 * binding is polled with a long budget on purpose: this suite shares a machine
 * with other Electron E2E runs, where a bound pane is slow, not absent.
 */
import { expect, type Page } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import { waitForActivePaneHookDescriptor, waitForActivePanePtyId } from './terminal'

const PANE_BINDING_TIMEOUT_MS = 120_000

export async function resolveActivePaneHandle(page: Page, client: RuntimeClient): Promise<string> {
  await waitForActivePanePtyId(page, PANE_BINDING_TIMEOUT_MS)
  const { paneKey } = await waitForActivePaneHookDescriptor(page, PANE_BINDING_TIMEOUT_MS)
  const resolved = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey
  })
  return resolved.result.terminal.handle
}

export async function waitForRegisteredWorktree(
  client: RuntimeClient,
  worktreeId: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        return listed.result.worktrees.some((worktree) => worktree.id === worktreeId)
      },
      { timeout: 90_000, message: 'runtime never registered the worktree' }
    )
    .toBe(true)
}

/** A second plain shell in no Run: the other half of `send --to <handle>`. Returns its PTY id. */
export async function createPeerTerminalPty(
  client: RuntimeClient,
  worktreeId: string
): Promise<string> {
  const created = await client.call<{ terminal: { handle: string } }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    title: 'guide contract peer'
  })
  const handle = created.result.terminal.handle
  const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
  const ptyId = listed.result.terminals.find((entry) => entry.handle === handle)?.ptyId
  if (!ptyId) {
    throw new Error(`terminal.create returned ${handle} with no PTY`)
  }
  return ptyId
}

/** An operator-created agent terminal, which is what `dispatch --inject` targets. */
export async function createAgentTerminal(
  client: RuntimeClient,
  worktreeId: string,
  command: string
): Promise<string> {
  const created = await client.call<{ terminal: { handle: string } }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    command,
    launchAgent: 'codex',
    title: 'guide contract inject target'
  })
  const handle = created.result.terminal.handle
  await expect
    .poll(
      async () => {
        const inspected = await client.call<{ process: { foregroundProcess: string | null } }>(
          'terminal.inspectProcess',
          { terminal: handle }
        )
        return inspected.result.process.foregroundProcess
      },
      { timeout: 60_000, message: 'the inject target never started an agent process' }
    )
    .toBeTruthy()
  return handle
}

export async function handleForPty(client: RuntimeClient, ptyId: string): Promise<string> {
  let handle: string | null = null
  await expect
    .poll(
      async () => {
        const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
        handle = listed.result.terminals.find((entry) => entry.ptyId === ptyId)?.handle ?? null
        return handle
      },
      { timeout: PANE_BINDING_TIMEOUT_MS, message: `no live terminal is attached to pty ${ptyId}` }
    )
    .toBeTruthy()
  return handle as unknown as string
}
