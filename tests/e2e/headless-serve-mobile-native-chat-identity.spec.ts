/**
 * #10923: a phone paired straight to a headless `orca serve` must learn each terminal agent's
 * provider session from `session.tabs.list`, or native chat has no transcript to read and stays
 * empty. The agents are fakes that pipe hook JSON through Orca's own managed hook scripts from
 * inside the serve's PTY, so the hook endpoint, pane key and tab-list projection are all real.
 * Real Codex 0.162 behaves the same way: a typed session reports its identity on its first turn,
 * and `codex resume` reports nothing until the user sends a message.
 */
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import { pairMobileClient, type PairedMobileClient } from './helpers/paired-mobile-client'
import { getManagedScript as getClaudeManagedScript } from '../../src/main/claude/hook-script'
import { getManagedScript as getCodexManagedScript } from '../../src/main/codex/codex-hook-script'
import type { AgentStatusEntry } from '../../src/shared/agent-status-types'
import type { AiVaultSession } from '../../src/shared/ai-vault-types'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-terminal-contracts'
import type { RuntimeWorktreePsSummary } from '../../src/shared/runtime-worktree-contracts'
import { buildMobileAiVaultResumeLaunch } from '../../mobile/src/session/ai-vault-resume-launch'

test.skip(process.platform === 'win32', 'the fake agents are POSIX shell scripts')

type FakeAgent = 'claude' | 'codex'
type ListedTerminal = RuntimeTerminalListResult['terminals'][number]

function transcriptLines(agent: FakeAgent, sessionId: string, cwd: string): string {
  const now = Date.now()
  const at = (offset: number) => new Date(now + offset).toISOString()
  const lines =
    agent === 'codex'
      ? [
          { timestamp: at(0), type: 'session_meta', payload: { id: sessionId, cwd } },
          // Codex records chat text as event_msg rows; the response_item copies are model input.
          {
            timestamp: at(1),
            type: 'event_msg',
            payload: { type: 'user_message', message: 'codex question' }
          },
          {
            timestamp: at(2),
            type: 'event_msg',
            payload: { type: 'agent_message', message: 'codex answer' }
          }
        ]
      : [
          {
            sessionId,
            uuid: `${sessionId}-user`,
            timestamp: at(0),
            type: 'user',
            cwd,
            message: { role: 'user', content: [{ type: 'text', text: 'claude question' }] }
          },
          {
            sessionId,
            uuid: `${sessionId}-assistant`,
            timestamp: at(1),
            type: 'assistant',
            cwd,
            message: { model: 'claude-opus-4', content: [{ type: 'text', text: 'claude answer' }] }
          }
        ]
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

/** A fake agent: writes its transcript, then reports the same hook events the real CLI does. */
function writeFakeAgent(dir: string, agent: FakeAgent, sessionId: string, cwd: string): string {
  const transcriptPath = path.join(dir, `${agent}-${sessionId}.jsonl`)
  writeFileSync(transcriptPath, transcriptLines(agent, sessionId, cwd))
  const hookScript = path.join(dir, `${agent}-hook.sh`)
  writeFileSync(
    hookScript,
    agent === 'codex' ? getCodexManagedScript('posix') : getClaudeManagedScript('posix')
  )
  chmodSync(hookScript, 0o755)
  const event = (name: string, extra: Record<string, unknown>) =>
    JSON.stringify({
      hook_event_name: name,
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd,
      ...(agent === 'codex' ? { model: 'gpt-5-codex' } : {}),
      ...extra
    })
  const events = [
    event('SessionStart', { source: 'startup' }),
    event('UserPromptSubmit', {
      prompt: `${agent} question`,
      ...(agent === 'codex' ? { turn_id: 'turn-1' } : {})
    }),
    event('Stop', {
      last_assistant_message: `${agent} answer`,
      ...(agent === 'codex' ? { turn_id: 'turn-1' } : {})
    })
  ]
  const agentScript = path.join(dir, agent)
  writeFileSync(
    agentScript,
    [
      '#!/bin/sh',
      ...events.map((payload) => `printf '%s' '${payload}' | sh '${hookScript}'`),
      `echo FAKE_${agent.toUpperCase()}_REPORTED`,
      // Stay in the foreground like a real agent waiting at its prompt.
      'exec sleep 600',
      ''
    ].join('\n')
  )
  chmodSync(agentScript, 0o755)
  return agentScript
}

async function openPhoneWorkspace(
  host: HeadlessPairedRuntimeHost,
  phone: PairedMobileClient,
  repoPath: string
): Promise<string> {
  await host.client.call('repo.add', { path: repoPath, kind: 'git' })
  let worktreeId = ''
  await expect
    .poll(
      async () => {
        const { worktrees } = await phone.call<{ worktrees: RuntimeWorktreePsSummary[] }>(
          'worktree.ps',
          { limit: 1_000 }
        )
        worktreeId = worktrees.find((row) => row.path === repoPath)?.worktreeId ?? ''
        return worktreeId
      },
      { timeout: 30_000 }
    )
    .not.toBe('')
  return `id:${worktreeId}`
}

async function waitForTerminal(
  phone: PairedMobileClient,
  worktree: string,
  matches: (row: ListedTerminal) => boolean
): Promise<ListedTerminal> {
  let found: ListedTerminal | undefined
  await expect
    .poll(
      async () => {
        const { terminals } = await phone.call<RuntimeTerminalListResult>('terminal.list', {
          worktree
        })
        found = terminals.find(matches)
        return found?.handle ?? ''
      },
      { timeout: 30_000 }
    )
    .not.toBe('')
  if (!found) {
    throw new Error('terminal not listed')
  }
  return found
}

/** What the phone's chat view does: read the session tab list, then the transcript it names. */
async function expectPhoneChatReadsTranscript(args: {
  phone: PairedMobileClient
  worktree: string
  parentTabId: string
  agent: FakeAgent
  sessionId: string
}): Promise<void> {
  const { phone, worktree, parentTabId, agent, sessionId } = args
  let agentStatus: AgentStatusEntry | null | undefined
  await expect
    .poll(
      async () => {
        const result = await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
          worktree
        })
        const listed = result.tabs.find(
          (row) => row.type === 'terminal' && row.parentTabId === parentTabId
        )
        agentStatus = listed?.type === 'terminal' ? listed.agentStatus : undefined
        return agentStatus?.providerSession?.id ?? null
      },
      { timeout: 30_000, message: `${agent} providerSession in session.tabs.list` }
    )
    .toBe(sessionId)
  expect(agentStatus?.agentType).toBe(agent)
  const transcriptPath = agentStatus?.providerSession?.transcriptPath
  const read = await phone.call<{ messages?: { role: string }[]; error?: string }>(
    'nativeChat.readSession',
    { agent, sessionId, ...(transcriptPath ? { transcriptPath } : {}) }
  )
  expect(read.error, `${agent} nativeChat.readSession`).toBeUndefined()
  expect(read.messages?.map((message) => message.role)).toEqual(['user', 'assistant'])
}

test('a phone paired to headless serve gets each terminal agent its provider session', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-10923-'))
  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'mobile' })
  const phone = pairMobileClient(host.offer)
  try {
    const worktree = await openPhoneWorkspace(host, phone, testRepoPath)
    for (const agent of ['codex', 'claude'] as const) {
      const sessionId = `${agent}-10923-${Date.now()}`
      const agentScript = writeFakeAgent(fakeDir, agent, sessionId, testRepoPath)
      const { tab } = await phone.call<{ tab: { id: string; parentTabId: string } }>(
        'session.tabs.createTerminal',
        {
          worktree,
          clientMutationId: `create-${agent}`,
          activate: false,
          select: true,
          navigation: 'caller'
        }
      )
      const terminal = await waitForTerminal(
        phone,
        worktree,
        (row) => row.tabId === tab.parentTabId
      )
      await phone.call('terminal.send', {
        terminal: terminal.handle,
        text: `'${agentScript}'`,
        enter: true
      })
      await expectPhoneChatReadsTranscript({
        phone,
        worktree,
        parentTabId: tab.parentTabId,
        agent,
        sessionId
      })
    }
  } finally {
    await host.dispose()
    rmSync(fakeDir, { recursive: true, force: true })
  }
})

// Codex runs SessionStart only at its first turn, so a resumed session is silent until the user
// types. The host launched the resume, so it already knows which session the pane holds.
test('a phone can read a resumed Codex chat before its first new turn', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-10923-'))
  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'mobile' })
  const phone = pairMobileClient(host.offer)
  try {
    const worktree = await openPhoneWorkspace(host, phone, testRepoPath)
    const sessionId = randomUUID()
    const transcriptPath = path.join(fakeDir, `rollout-2026-10-16T00-00-00-${sessionId}.jsonl`)
    writeFileSync(transcriptPath, transcriptLines('codex', sessionId, testRepoPath))
    const resumedCodex = path.join(fakeDir, 'codex-resumed')
    writeFileSync(resumedCodex, '#!/bin/sh\necho FAKE_CODEX_RESUMED\nexec sleep 600\n')
    chmodSync(resumedCodex, 0o755)
    const created = await host.client.call<{ terminal: { handle: string } }>('terminal.create', {
      worktree,
      command: `'${resumedCodex}'`,
      launchAgent: 'codex',
      resumeProviderSession: { key: 'session_id', id: sessionId, transcriptPath }
    })
    const terminal = await waitForTerminal(
      phone,
      worktree,
      (row) => row.handle === created.result.terminal.handle
    )
    await expectPhoneChatReadsTranscript({
      phone,
      worktree,
      parentTabId: terminal.tabId,
      agent: 'codex',
      sessionId
    })
  } finally {
    await host.dispose()
    rmSync(fakeDir, { recursive: true, force: true })
  }
})

// The phone's Session History creates a shell pane and types the resume into it, so the host
// never spawns the agent itself; the create names the conversation so the host can record it.
test('a phone can read a Codex chat it resumed from Session History before its first new turn', async ({
  testRepoPath
}) => {
  test.setTimeout(240_000)
  const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-10923-'))
  const host = await launchHeadlessPairedRuntimeHost({ pairingScope: 'mobile' })
  const phone = pairMobileClient(host.offer)
  try {
    const worktree = await openPhoneWorkspace(host, phone, testRepoPath)
    const sessionId = randomUUID()
    // A saved Codex conversation in the serve's own (isolated) Codex home, as History lists it.
    const rolloutDir = path.join(host.env.HOME!, '.codex', 'sessions', '2026', '10', '16')
    mkdirSync(rolloutDir, { recursive: true })
    writeFileSync(
      path.join(rolloutDir, `rollout-2026-10-16T00-00-00-${sessionId}.jsonl`),
      transcriptLines('codex', sessionId, testRepoPath)
    )
    let session: AiVaultSession | undefined
    await expect
      .poll(
        async () => {
          const scan = await phone.call<{ sessions: AiVaultSession[] }>('aiVault.listSessions', {
            limit: 50,
            force: true,
            scopePaths: [testRepoPath]
          })
          session = scan.sessions.find((row) => row.sessionId === sessionId)
          return session?.agent ?? ''
        },
        { timeout: 30_000, message: 'Session History lists the saved Codex conversation' }
      )
      .toBe('codex')
    const resumedCodex = path.join(fakeDir, 'codex-resumed')
    writeFileSync(resumedCodex, '#!/bin/sh\necho FAKE_CODEX_RESUMED\nexec sleep 600\n')
    chmodSync(resumedCodex, 0o755)
    // The phone's own builder, with the agent command pointed at the fake.
    const launch = buildMobileAiVaultResumeLaunch({
      session: session!,
      hostPlatform: process.platform,
      settings: { agentCmdOverrides: { codex: resumedCodex } }
    })
    const { tab } = await phone.call<{ tab: { parentTabId: string } }>(
      'session.tabs.createTerminal',
      {
        worktree,
        ...(launch.env ? { env: launch.env } : {}),
        ...(launch.envToDelete ? { envToDelete: launch.envToDelete } : {}),
        ...(launch.launchConfig ? { launchConfig: launch.launchConfig } : {}),
        launchAgent: launch.launchAgent,
        ...(launch.resumeProviderSession
          ? { resumeProviderSession: launch.resumeProviderSession }
          : {}),
        clientMutationId: `resume-${sessionId}`,
        activate: false,
        select: true,
        navigation: 'caller'
      }
    )
    const terminal = await waitForTerminal(phone, worktree, (row) => row.tabId === tab.parentTabId)
    await phone.call('terminal.send', {
      terminal: terminal.handle,
      text: launch.command,
      enter: true
    })
    await expectPhoneChatReadsTranscript({
      phone,
      worktree,
      parentTabId: tab.parentTabId,
      agent: 'codex',
      sessionId
    })
  } finally {
    await host.dispose()
    rmSync(fakeDir, { recursive: true, force: true })
  }
})
