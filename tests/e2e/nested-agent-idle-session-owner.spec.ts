import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  readSink,
  retentionFixtureCommand,
  writeRetentionFixture
} from './helpers/host-created-terminal-retention-oracle'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient } from './helpers/paired-mobile-client'
import { readAgentProcess } from '../../src/shared/agent-process-presence-probe'
import { resolveMobileNativeChat } from '../../mobile/src/session/mobile-native-chat-eligibility'
import type { RuntimeMobileSessionTabsResult } from '../../src/shared/runtime-session-contracts'

const SESSION = '11111111-2222-4333-8444-555555555555'
const REPLY = 'Foreground Claude reply stays selected while a nested Codex reviews.'

test('idle Claude keeps chat, mobile transcript, and return identity through nested Codex hooks', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.skip(process.platform === 'win32', 'Claude hook process capture is POSIX-only')
  const dir = mkdtempSync(join(tmpdir(), 'orca-idle-owner-e2e-'))
  registerPostElectronShutdownCleanup(async () => rmSync(dir, { recursive: true, force: true }))
  const transcriptPath = join(dir, `${SESSION}.jsonl`)
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({
      sessionId: SESSION,
      userText: 'Keep my foreground session.',
      assistantText: REPLY
    })
  )
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const sinkPath = join(dir, 'foreground-agent.log')
  const fixturePath = writeRetentionFixture(dir, { processTitle: 'claude' })
  await execInTerminal(orcaPage, ptyId, retentionFixtureCommand(fixturePath, sinkPath))
  await expect.poll(() => readSink(sinkPath)).toMatch(/^READY:\d+/)
  const pid = Number(readSink(sinkPath).match(/^READY:(\d+)/)?.[1])
  const observed = await readAgentProcess(pid)
  expect(observed.verdict).toBe('live')
  if (observed.verdict !== 'live') {
    throw new Error('The foreground fixture must have a verifiable identity')
  }
  const processIdentity = { pid, platform: process.platform, startTime: observed.startTime }
  const [tabId] = descriptor.paneKey.split(':')
  const endpoint = await readHookEndpoint(electronApp)
  const post = async (source: string, hook_event_name: string) => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/${source}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': endpoint.token },
      body: JSON.stringify({
        ...descriptor,
        tabId,
        env: endpoint.env,
        version: endpoint.version,
        ...(source === 'claude' ? { agentProcess: processIdentity } : {}),
        payload: {
          hook_event_name,
          session_id: source === 'claude' ? SESSION : '66666666-7777-4888-8999-000000000000',
          ...(source === 'claude' ? { transcript_path: transcriptPath } : {}),
          ...(hook_event_name === 'UserPromptSubmit'
            ? {
                prompt: source === 'claude' ? 'Keep my foreground session.' : 'Nested Codex review'
              }
            : {})
        }
      })
    })
    expect(response.status).toBe(204)
  }
  await post('claude', 'UserPromptSubmit')
  await post('claude', 'Stop')
  await expect
    .poll(() =>
      orcaPage.evaluate(
        (key) => window.__store?.getState().agentStatusByPaneKey[key]?.state,
        descriptor.paneKey
      )
    )
    .toBe('done')
  await enableNativeChatSetting(orcaPage)
  await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(chat.getByText(REPLY, { exact: true })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('01-claude-before-nested.png') })
  expect(
    await orcaPage.evaluate(
      async (key) => (await window.api.agentStatus.hasVerifiableAgentProcess?.(key)) ?? false,
      descriptor.paneKey
    )
  ).toBe(true)
  for (const event of [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PermissionRequest',
    'Stop'
  ]) {
    await post('codex', event)
    await expect(chat.getByText(REPLY, { exact: true })).toBeVisible()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (key) => window.__store?.getState().agentStatusByPaneKey[key]?.providerSession?.id,
          descriptor.paneKey
        )
      )
      .toBe(SESSION)
  }
  await orcaPage.screenshot({ path: testInfo.outputPath('02-claude-after-nested.png') })

  const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
  try {
    const result = await phone.call<RuntimeMobileSessionTabsResult>('session.tabs.list', {
      worktree: `id:${descriptor.worktreeId}`
    })
    const tab = result.tabs.find((tab) => tab.type === 'terminal' && tab.parentTabId === tabId)
    expect(tab).toBeDefined()
    const resolution = resolveMobileNativeChat(tab ?? null, true)
    expect(resolution).toMatchObject({ agent: 'claude', sessionId: SESSION })
    if (!resolution) {
      throw new Error('Phone lost the foreground transcript')
    }
    const transcript = await phone.call<unknown>('nativeChat.readSession', {
      ...resolution,
      limit: 50
    })
    expect(JSON.stringify(transcript)).toContain(REPLY)
    expect(JSON.stringify(transcript)).not.toContain('Nested Codex review')
  } finally {
    phone.dispose()
  }

  await orcaPage.getByRole('button', { name: 'Show terminal', exact: true }).click()
  await expect(chat).toHaveCount(0)
  await expect(
    orcaPage.getByText('Orca could not verify the originating Codex session file', { exact: false })
  ).toHaveCount(0)
  expect(
    await orcaPage.evaluate(
      (key) => window.__store?.getState().agentStatusByPaneKey[key]?.providerSession?.id,
      descriptor.paneKey
    )
  ).toBe(SESSION)
  await orcaPage.screenshot({ path: testInfo.outputPath('03-return-to-terminal.png') })
})
