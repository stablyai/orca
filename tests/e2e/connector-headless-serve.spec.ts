// Drives the hidden `orca connector` CLI end to end against a real headless serve host and a scripted Claude.
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { orcaCliResult, runCompiledOrcaCli } from './helpers/compiled-orca-cli'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  FAKE_CLAUDE_KEEPS_WORKING,
  FAKE_CLAUDE_NEEDS_APPROVAL,
  writeFakeClaude,
  type FakeClaude
} from './helpers/connector-fake-claude'
import Database from '../../src/main/sqlite/sync-database'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'

test.skip(process.platform === 'win32', 'the scripted Claude runs its hooks through sh')

const PromptRead = z.object({
  prompt: z
    .object({
      kind: z.string(),
      promptId: z.string(),
      tool: z.string().optional(),
      summary: z.string().optional()
    })
    .nullable()
})
const WatchRead = z.object({
  snapshot: z.object({ conversations: z.array(z.object({ working: z.boolean() })) }),
  events: z.array(
    z.object({
      kind: z.string(),
      stopReason: z.string().nullable().optional(),
      lastAssistantMessage: z.string().optional()
    })
  )
})

const connectorCli = (userDataDir: string, args: string[], timeoutMs?: number) =>
  orcaCliResult<unknown>(userDataDir, ['connector', ...args], timeoutMs)

/** A command the host refuses; returns its error code. */
async function refusedCode(userDataDir: string, args: string[]): Promise<string | undefined> {
  const run = await runCompiledOrcaCli(userDataDir, ['connector', ...args, '--json'])
  return run.json?.error?.code
}

function conversationCli(userDataDir: string, conversation: string) {
  const call = (args: string[]) => connectorCli(userDataDir, args)
  const on = ['--conversation', conversation]
  return {
    start: async (deliveryId: string, prompt: string, worktree: string) =>
      z
        .object({ initial: z.unknown() })
        .parse(
          await call([
            'start',
            ...on,
            '--delivery-id',
            deliveryId,
            '--agent',
            'claude',
            '--prompt',
            prompt,
            '--worktree',
            worktree
          ])
        ).initial,
    send: (deliveryId: string, text: string) =>
      call(['send', ...on, '--delivery-id', deliveryId, '--text', text]),
    prompt: async () => PromptRead.parse(await call(['prompt', ...on])).prompt,
    answer: (promptId: string, option: string) =>
      call(['answer', ...on, '--prompt-id', promptId, '--option', option]),
    cancel: (deliveryId: string) => call(['cancel', ...on, '--delivery-id', deliveryId]),
    /** The host's own read of whether the agent is mid-turn, from a zero-length watch's snapshot. */
    working: async () =>
      WatchRead.parse(await call(['watch', '--for-ms', '0'])).snapshot.conversations.some(
        (linked) => linked.working
      )
  }
}

/** Receipt state for one delivery id, read from the host's orchestration ledger. */
function receiptState(
  userDataDir: string,
  conversation: string,
  deliveryId: string
): string | null {
  const db = new Database(path.join(userDataDir, 'orchestration.db'), { readonly: true })
  try {
    const row = db
      .prepare(
        'SELECT state FROM mutation_receipts WHERE caller_fingerprint = ? AND request_id = ?'
      )
      .get('connector:dev', JSON.stringify([conversation, deliveryId]))
    return z.object({ state: z.string() }).optional().parse(row)?.state ?? null
  } finally {
    db.close()
  }
}

function turns(claude: FakeClaude): string[] {
  return claude.ledger().flatMap((line) => (line.startsWith('turn:') ? [line.slice(5)] : []))
}

async function openWorkspace(host: HeadlessPairedRuntimeHost, repoPath: string): Promise<string> {
  await host.client.call('repo.add', { path: repoPath, kind: 'git' })
  let worktreeId = ''
  await expect
    .poll(async () => {
      const listed = await host.client.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
        'worktree.ps',
        { limit: 1_000 }
      )
      worktreeId = listed.result.worktrees.find((row) => row.path === repoPath)?.worktreeId ?? ''
      return worktreeId
    })
    .not.toBe('')
  return `id:${worktreeId}`
}

/** Polls until the conversation's agent asks for approval, and returns that prompt id. */
async function waitForApproval(cli: ReturnType<typeof conversationCli>): Promise<string> {
  let promptId = ''
  await expect
    .poll(
      async () => {
        const prompt = await cli.prompt()
        promptId = prompt?.promptId ?? ''
        return prompt && { kind: prompt.kind, tool: prompt.tool, summary: prompt.summary }
      },
      { timeout: 20_000 }
    )
    .toEqual({ kind: 'approval', tool: 'Bash', summary: 'touch approved.txt' })
  return promptId
}

test('a connector conversation runs end to end on a headless serve host', async ({
  testRepoPath
}) => {
  // Two serve launches (the restart) plus about thirty CLI round trips.
  test.setTimeout(240_000)
  const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-connector-'))
  const claude = writeFakeClaude(fakeDir)
  const host = await launchHeadlessPairedRuntimeHost({ pinnedServePort: true })
  const { userDataDir } = host
  const c1 = conversationCli(userDataDir, 'c1')
  /** What the agent read since a ledger mark, joined across PTY chunk boundaries, and what it did. */
  const since = (mark: number) => {
    const lines = claude.ledger().slice(mark)
    const keys = lines.filter((line) => line.startsWith('keys:'))
    return {
      typed: keys.map((line) => JSON.parse(line.slice('keys:'.length))).join(''),
      did: lines.filter((line) => !line.startsWith('keys:'))
    }
  }
  const nothing = { typed: '', did: [] }
  try {
    await host.client.call('settings.mutateAgentLaunch', {
      type: 'command',
      agent: 'claude',
      value: claude.command
    })
    expect(await refusedCode(userDataDir, ['prompt', '--conversation', 'c1'])).toBe(
      'connectors_disabled'
    )
    await host.client.call('settings.update', { experimentalConnectors: true })
    // Disabling connectors ends the window, so the watch returns everything seen until then.
    // A plain run, not an asserting one: it stays outstanding while later steps may fail first.
    const watching = runCompiledOrcaCli(
      userDataDir,
      ['connector', 'watch', '--for-ms', '600000', '--json'],
      660_000
    )
    const worktree = await openWorkspace(host, testRepoPath)

    // Start, then a retried delivery that must not type again.
    expect(await c1.start('d1', 'hello', worktree)).toEqual({ outcome: 'accepted' })
    await expect.poll(() => turns(claude)).toEqual(['hello'])
    expect(await c1.start('d1', 'hello', worktree)).toEqual({ outcome: 'accepted' })
    expect(await c1.send('d1', 'other payload')).toEqual({
      outcome: 'refused',
      reason: 'delivery_id_reused'
    })

    // Follow-up, and its duplicate delivery.
    expect(await c1.send('d2', 'second')).toEqual({ outcome: 'accepted' })
    await expect.poll(() => turns(claude)).toEqual(['hello', 'second'])
    expect(await c1.send('d2', 'second')).toEqual({ outcome: 'accepted' })

    // An approval reads back, and a follow-up waits behind it until it is answered.
    expect(await c1.send('d3', `run it ${FAKE_CLAUDE_NEEDS_APPROVAL}`)).toEqual({
      outcome: 'accepted'
    })
    const promptId = await waitForApproval(c1)
    const beforeHeld = claude.ledger().length
    const held = c1.send('d4', 'after approval')
    await expect.poll(() => receiptState(userDataDir, 'c1', 'd4')).toBe('pending')
    expect(since(beforeHeld)).toEqual(nothing)
    expect(await c1.answer('p_not_this_one', 'allow_once')).toEqual({
      outcome: 'refused',
      reason: 'prompt_not_pending'
    })
    expect(await c1.answer(promptId, 'allow_always')).toEqual({
      outcome: 'refused',
      reason: 'option_not_offered'
    })
    expect(await c1.answer(promptId, 'allow_once')).toEqual({ outcome: 'accepted' })
    expect(await held).toEqual({ outcome: 'accepted' })
    await expect
      .poll(() => since(beforeHeld))
      .toEqual({
        typed: '1\x1b[200~after approval\x1b[201~\r',
        did: ['approved', 'turn:after approval']
      })
    expect(await c1.answer(promptId, 'allow_once')).toEqual({
      outcome: 'refused',
      reason: 'prompt_not_pending'
    })

    // Cancel while idle types nothing.
    await expect.poll(() => c1.working()).toBe(false)
    const beforeIdleCancel = claude.ledger().length
    expect(await c1.cancel('k1')).toEqual({ outcome: 'accepted' })
    expect(since(beforeIdleCancel)).toEqual(nothing)

    // Cancel while working sends one Escape, and the host settles the turn as cancelled.
    expect(await c1.send('d5', `long job ${FAKE_CLAUDE_KEEPS_WORKING}`)).toEqual({
      outcome: 'accepted'
    })
    await expect.poll(() => turns(claude).at(-1)).toBe(`long job ${FAKE_CLAUDE_KEEPS_WORKING}`)
    const beforeBusyCancel = claude.ledger().length
    expect(await c1.cancel('k2')).toEqual({ outcome: 'accepted' })
    await expect
      .poll(() => since(beforeBusyCancel))
      .toEqual({ typed: '\x1b', did: ['interrupted'] })
    await expect.poll(() => c1.working()).toBe(false)

    // Cancel during an approval rejects it and drops the follow-up held behind it.
    expect(await c1.send('d6', `again ${FAKE_CLAUDE_NEEDS_APPROVAL}`)).toEqual({
      outcome: 'accepted'
    })
    await waitForApproval(c1)
    const beforeReject = claude.ledger().length
    const dropped = c1.send('d7', 'never typed')
    await expect.poll(() => receiptState(userDataDir, 'c1', 'd7')).toBe('pending')
    expect(await c1.cancel('k3')).toEqual({ outcome: 'accepted' })
    expect(await dropped).toEqual({ outcome: 'refused', reason: 'conversation_cancelled' })
    await expect.poll(() => since(beforeReject)).toEqual({ typed: '\x1b', did: ['rejected'] })
    expect(await c1.prompt()).toBeNull()

    await host.client.call('settings.update', { experimentalConnectors: false })
    const watched = await watching
    expect(watched.code, watched.stdout + watched.stderr).toBe(0)
    const { snapshot, events } = WatchRead.parse(watched.json?.result)
    // Subscribing precedes the snapshot, so an empty one proves no event before the start was missed.
    expect(snapshot.conversations).toEqual([])
    expect(
      events.map((event) =>
        event.kind === 'turn-ended'
          ? `${event.kind}:${event.lastAssistantMessage ?? ''}:${event.stopReason ?? ''}`
          : event.kind
      )
    ).toEqual([
      'linked',
      'turn-started',
      'turn-ended:REPLY hello:',
      'turn-started',
      'turn-ended:REPLY second:',
      'turn-started',
      'prompt',
      'turn-ended:APPROVED:',
      'turn-started',
      'turn-ended:REPLY after approval:',
      'turn-started',
      'turn-ended::cancellation',
      'turn-started',
      'prompt',
      'turn-ended::cancellation'
    ])
    expect(
      await refusedCode(userDataDir, ['cancel', '--conversation', 'c1', '--delivery-id', 'k4'])
    ).toBe('connectors_disabled')

    // A delivery still held when the host stops reads unknown after restart, never redelivered.
    await host.client.call('settings.update', { experimentalConnectors: true })
    expect(await c1.send('d8', `third ${FAKE_CLAUDE_NEEDS_APPROVAL}`)).toEqual({
      outcome: 'accepted'
    })
    await waitForApproval(c1)
    // The CLI's own call dies with the host; only the host's receipt matters here.
    const interrupted = runCompiledOrcaCli(userDataDir, [
      'connector',
      'send',
      '--conversation',
      'c1',
      '--delivery-id',
      'd9',
      '--text',
      'held over restart'
    ])
    await expect.poll(() => receiptState(userDataDir, 'c1', 'd9')).toBe('pending')
    await host.restartServeProcess()
    await interrupted
    expect(await c1.send('d9', 'held over restart')).toEqual({
      outcome: 'unknown',
      reason: 'replayed_after_restart'
    })
    expect(turns(claude)).not.toContain('held over restart')
  } finally {
    await host.dispose()
    rmSync(fakeDir, { recursive: true, force: true })
  }
})
