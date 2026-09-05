import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@stablyai/playwright-test'
import SyncDatabase from '../../src/main/sqlite/sync-database'
import { grokEncodedCwdDirName } from '../../src/shared/grok-session-paths'
import { expect, test } from './helpers/orca-app'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor } from './helpers/terminal'
import type { ActivePaneHookDescriptor } from './helpers/terminal-pane-identity'

const BASE = Date.parse('2026-09-02T14:12:22.409Z')
// Why: the OpenCode reader locates opencode.db through XDG_DATA_HOME, which must be in the app's launch env.
const OPENCODE_DATA_HOME = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-opencode-home-'))

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function claudeRow(record: Record<string, unknown>, offsetMs: number): string {
  return JSON.stringify({ ...record, timestamp: at(offsetMs) })
}

function claudeAssistantRow(args: {
  uuid: string
  parentUuid: string
  messageId: string
  outputTokens: number
  offsetMs: number
}): string {
  return claudeRow(
    {
      type: 'assistant',
      uuid: args.uuid,
      parentUuid: args.parentUuid,
      message: {
        id: args.messageId,
        model: 'claude-e2e',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 10, output_tokens: args.outputTokens }
      }
    },
    args.offsetMs
  )
}

function codexRow(type: string, payload: Record<string, unknown>, offsetMs: number): string {
  return JSON.stringify({ timestamp: at(offsetMs), type, payload })
}

function codexTokenCount(offsetMs: number, outputTokens: number, totalOutput: number): string {
  return codexRow(
    'event_msg',
    {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: 1000,
          output_tokens: totalOutput,
          total_tokens: 1000 + totalOutput
        },
        last_token_usage: {
          input_tokens: 500,
          output_tokens: outputTokens,
          total_tokens: 500 + outputTokens
        }
      }
    },
    offsetMs
  )
}

async function postHook(
  app: ElectronApplication,
  source: 'claude' | 'codex' | 'gemini' | 'opencode' | 'grok',
  descriptor: ActivePaneHookDescriptor,
  payload: Record<string, unknown>,
  envelope: Record<string, unknown> = {}
): Promise<void> {
  const endpoint = await readHookEndpoint(app)
  const [tabId] = descriptor.paneKey.split(':')
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/${source}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      paneKey: descriptor.paneKey,
      tabId,
      worktreeId: descriptor.worktreeId,
      env: endpoint.env,
      version: endpoint.version,
      ...envelope,
      payload
    })
  })
  expect(response.status).toBe(204)
}

// Why: optional PR evidence. The status bar is a 24 px strip, so a bottom crop reads better than a full window.
// Why: the style guide asks UI changes to be checked in both themes; an evidence run picks one.
const evidenceTheme = process.env.ORCA_THROUGHPUT_EVIDENCE_THEME
const EVIDENCE_THEME: 'dark' | 'light' | null =
  evidenceTheme === 'dark' || evidenceTheme === 'light' ? evidenceTheme : null

async function captureEvidence(
  page: Page,
  name: string,
  options: { full?: boolean; stripHeight?: number } = {}
): Promise<void> {
  const dir = process.env.ORCA_THROUGHPUT_EVIDENCE_DIR
  if (!dir) {
    return
  }
  mkdirSync(dir, { recursive: true })
  const fileName = EVIDENCE_THEME ? `${name}-${EVIDENCE_THEME}` : name
  if (options.full) {
    await page.screenshot({ path: path.join(dir, `${fileName}.png`) })
  }
  // Why: Electron pages report no Playwright viewport; the window's own size is the real one.
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }))
  // Why: the readout sits in the right-hand cluster; a full-width strip makes it unreadable.
  const height = options.stripHeight ?? 40
  const width = Math.min(viewport.width, 720)
  await page.screenshot({
    path: path.join(dir, `${fileName}-status-bar.png`),
    clip: { x: viewport.width - width, y: viewport.height - height, width, height }
  })
}

// Why: the tooltip is the only place the message size, duration and agent show, so hover must
// open it; the star nag can cover that corner, so dismiss it first.
async function expectTooltip(
  page: Page,
  trigger: Locator,
  expectedTexts: readonly string[],
  evidenceName = 'after-tooltip'
): Promise<void> {
  const later = page.getByRole('button', { name: 'Later' })
  if (await later.isVisible().catch(() => false)) {
    await later.click()
  }
  await trigger.hover()
  for (const expectedText of expectedTexts) {
    // Why: Radix renders the content twice (visible popper + visually hidden a11y copy); the popper comes first.
    await expect(page.getByText(expectedText).first()).toBeVisible()
  }
  await captureEvidence(page, evidenceName, { stripHeight: 160 })
  await page.mouse.move(0, 0)
}

async function prepareFocusedPane(
  orcaPage: Page,
  options: { captureBefore?: boolean } = {}
): Promise<ActivePaneHookDescriptor> {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  if (EVIDENCE_THEME) {
    await orcaPage.evaluate((theme) => {
      window.__store?.getState().updateSettings({ theme })
    }, EVIDENCE_THEME)
  }
  if (options.captureBefore) {
    await captureEvidence(orcaPage, 'before', { full: true })
  }
  // Why: the readout is opt-in; the store enables it (setup) and the DOM proves it (assertion).
  await orcaPage.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    if (!store.getState().statusBarItems.includes('throughput')) {
      store.getState().toggleStatusBarItem('throughput')
    }
  })
  return descriptor
}

function createTranscriptDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-throughput-'))
}

test('shows tokens per second for the focused pane once a Claude message completes', async ({
  electronApp,
  orcaPage
}) => {
  const descriptor = await prepareFocusedPane(orcaPage, { captureBefore: true })
  // Why: an enabled item must be visible before any message completes, not silently absent.
  await expect(orcaPage.getByLabel('Agent throughput, n/a tok/s')).toHaveText('n/a tok/s')
  await captureEvidence(orcaPage, 'after-placeholder')
  const transcriptDir = createTranscriptDir()
  const transcriptPath = path.join(transcriptDir, 'session.jsonl')
  const lines = [
    claudeRow(
      { type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'go' } },
      0
    ),
    claudeAssistantRow({
      uuid: 'a1',
      parentUuid: 'u1',
      messageId: 'msg_1',
      outputTokens: 2497,
      offsetMs: 36_473
    })
  ]
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
  const session = {
    session_id: 'e2e-throughput-session',
    transcript_path: transcriptPath,
    cwd: transcriptDir
  }

  await postHook(electronApp, 'claude', descriptor, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'go'
  })
  await postHook(electronApp, 'claude', descriptor, {
    ...session,
    hook_event_name: 'Stop',
    last_assistant_message: 'done'
  })

  const firstReadout = orcaPage.getByLabel('Agent throughput, 68 tok/s')
  await expect(firstReadout).toBeVisible()
  await expect(firstReadout).toHaveText('68 tok/s')
  await captureEvidence(orcaPage, 'after', { full: true })
  await expectTooltip(orcaPage, firstReadout, [
    'In the bar: 68 tok/s, this turn’s average over 1 model response(s)',
    'Last request: 68 tok/s (2.5k tokens in 36.5s)',
    'Claude · claude-e2e'
  ])

  lines.push(
    claudeRow(
      {
        type: 'user',
        uuid: 'u2',
        parentUuid: 'a1',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }
      },
      40_000
    ),
    claudeAssistantRow({
      uuid: 'a2',
      parentUuid: 'u2',
      messageId: 'msg_2',
      outputTokens: 200,
      offsetMs: 45_000
    })
  )
  writeFileSync(transcriptPath, `${lines.join('\n')}\n`)
  await postHook(electronApp, 'claude', descriptor, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'again'
  })
  // Why: a new turn must keep the previous reading until its first message completes.
  await expect(orcaPage.getByLabel('Agent throughput, 68 tok/s')).toHaveText('68 tok/s')
  await expectTooltip(
    orcaPage,
    orcaPage.getByLabel('Agent throughput, 68 tok/s'),
    ['In the bar: 68 tok/s, last request (no message completed this turn yet)'],
    'after-new-turn-tooltip'
  )
  await postHook(electronApp, 'claude', descriptor, {
    ...session,
    hook_event_name: 'Stop',
    last_assistant_message: 'done again'
  })

  const secondReadout = orcaPage.getByLabel('Agent throughput, 40 tok/s')
  await expect(secondReadout).toBeVisible()
  await expect(secondReadout).toHaveText('40 tok/s')
})

test('shows tokens per second for a Codex pane from its rollout', async ({
  electronApp,
  orcaPage
}) => {
  const descriptor = await prepareFocusedPane(orcaPage)
  const rolloutDir = createTranscriptDir()
  const rolloutPath = path.join(rolloutDir, 'rollout.jsonl')
  // Why: mirrors a real rollout — the call's rows, then the tool output, then its token_count.
  writeFileSync(
    rolloutPath,
    `${[
      codexRow(
        'response_item',
        { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' },
        0
      ),
      codexTokenCount(0, 184, 184),
      codexRow('response_item', { type: 'reasoning', summary: [] }, 22_087),
      codexRow('response_item', { type: 'custom_tool_call', name: 'exec', input: 'ls' }, 29_293),
      codexRow(
        'response_item',
        { type: 'custom_tool_call_output', call_id: 'c2', output: 'files' },
        32_443
      ),
      codexTokenCount(32_444, 696, 880),
      codexRow('event_msg', { type: 'task_complete', last_agent_message: 'done' }, 32_450)
    ].join('\n')}\n`
  )
  const session = {
    session_id: 'e2e-codex-throughput-session',
    transcript_path: rolloutPath,
    cwd: rolloutDir,
    model: 'gpt-5.5'
  }

  await postHook(electronApp, 'codex', descriptor, {
    ...session,
    hook_event_name: 'UserPromptSubmit',
    prompt: 'list files'
  })
  await postHook(electronApp, 'codex', descriptor, {
    ...session,
    hook_event_name: 'Stop',
    last_assistant_message: 'done'
  })

  const readout = orcaPage.getByLabel('Agent throughput, 24 tok/s')
  await expect(readout).toBeVisible()
  await expect(readout).toHaveText('24 tok/s')
  await expectTooltip(
    orcaPage,
    readout,
    [
      'In the bar: 24 tok/s, this turn’s average over 1 model response(s)',
      'Last request: 24 tok/s (696 tokens in 29.3s)',
      'Codex · gpt-5.5'
    ],
    'after-codex-tooltip'
  )
})

test('shows an estimated tokens per second for a Grok pane from its session files', async ({
  electronApp,
  orcaPage
}) => {
  const descriptor = await prepareFocusedPane(orcaPage)
  const grokHome = createTranscriptDir()
  const cwd = path.join(grokHome, 'workspace')
  const sessionId = 'e2e-grok-throughput-session'
  const sessionDir = path.join(grokHome, 'sessions', grokEncodedCwdDirName(cwd)!, sessionId)
  mkdirSync(sessionDir, { recursive: true })
  // Why: Grok records no token counts; 800 visible characters over a 5 s loop estimate to ~40 tok/s.
  writeFileSync(
    path.join(sessionDir, 'events.jsonl'),
    `${[
      JSON.stringify({ ts: at(0), type: 'turn_started', model_id: 'grok-4.6' }),
      JSON.stringify({ ts: at(0), type: 'loop_started', loop_index: 1 }),
      JSON.stringify({ ts: at(1_200), type: 'first_token' }),
      JSON.stringify({ ts: at(1_200), type: 'phase_changed', phase: 'streaming_text' }),
      JSON.stringify({ ts: at(5_000), type: 'turn_ended', outcome: 'completed' })
    ].join('\n')}\n`
  )
  writeFileSync(
    path.join(sessionDir, 'chat_history.jsonl'),
    `${[
      JSON.stringify({ type: 'user', content: 'go' }),
      JSON.stringify({ type: 'assistant', content: 'x'.repeat(800), model_id: 'grok-4.6' })
    ].join('\n')}\n`
  )
  const session = { sessionId, cwd }
  const envelope = { grokHome }

  await postHook(
    electronApp,
    'grok',
    descriptor,
    { ...session, hook_event_name: 'UserPromptSubmit', prompt: 'go' },
    envelope
  )
  await postHook(electronApp, 'grok', descriptor, { ...session, hook_event_name: 'Stop' }, envelope)

  const readout = orcaPage.getByLabel('Agent throughput, ~40 tok/s')
  await expect(readout).toBeVisible()
  await expect(readout).toHaveText('~40 tok/s')
  await expectTooltip(
    orcaPage,
    readout,
    [
      'In the bar: ~40 tok/s, this turn’s average over 1 model response(s)',
      'Last request: ~40 tok/s (200 tokens in 5.0s)',
      'Grok · grok-4.6',
      'Estimated from text length; Grok records no token counts.'
    ],
    'after-grok-tooltip'
  )

  // Why: Grok's exit reaches Orca as a SessionEnd hook; the reading must not outlive the session.
  await postHook(
    electronApp,
    'grok',
    descriptor,
    { ...session, hook_event_name: 'SessionEnd' },
    envelope
  )
  await expect(orcaPage.getByLabel('Agent throughput, n/a tok/s')).toHaveText('n/a tok/s')
})

test('shows tokens per second for a Gemini CLI pane from its chat file', async ({
  electronApp,
  orcaPage
}) => {
  const descriptor = await prepareFocusedPane(orcaPage)
  const chatDir = createTranscriptDir()
  const chatPath = path.join(chatDir, 'session-e2e.json')
  // Why: Gemini writes one message per model call with `tokens`; output + thoughts over the gap to the previous message.
  writeFileSync(
    chatPath,
    JSON.stringify({
      sessionId: 'e2e-gemini-session',
      messages: [
        { id: 'u1', timestamp: at(0), type: 'user', content: 'go' },
        {
          id: 'g1',
          timestamp: at(8_000),
          type: 'gemini',
          content: 'done',
          model: 'gemini-3-pro',
          tokens: { input: 1_000, output: 300, cached: 0, thoughts: 100, tool: 0, total: 1_400 }
        }
      ]
    })
  )
  const session = { session_id: 'e2e-gemini-session', transcript_path: chatPath, cwd: chatDir }

  await postHook(electronApp, 'gemini', descriptor, {
    ...session,
    hook_event_name: 'BeforeAgent',
    prompt: 'go'
  })
  await postHook(electronApp, 'gemini', descriptor, {
    ...session,
    hook_event_name: 'AfterAgent',
    prompt_response: 'done'
  })

  const readout = orcaPage.getByLabel('Agent throughput, 50 tok/s')
  await expect(readout).toBeVisible()
  await expect(readout).toHaveText('50 tok/s')
  await expectTooltip(
    orcaPage,
    readout,
    [
      'In the bar: 50 tok/s, this turn’s average over 1 model response(s)',
      'Last request: 50 tok/s (400 tokens in 8.0s)',
      'Gemini · gemini-3-pro'
    ],
    'after-gemini-tooltip'
  )
})

test.describe('OpenCode', () => {
  test.use({ orcaAppExtraEnv: { XDG_DATA_HOME: OPENCODE_DATA_HOME } })

  test('shows tokens per second for an OpenCode pane from its database', async ({
    electronApp,
    orcaPage
  }) => {
    const descriptor = await prepareFocusedPane(orcaPage)
    const dataDir = path.join(OPENCODE_DATA_HOME, 'opencode')
    mkdirSync(dataDir, { recursive: true })
    const db = new SyncDatabase(path.join(dataDir, 'opencode.db'))
    db.exec(
      'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)'
    )
    // Why: OpenCode stamps each assistant message with its own created → completed span.
    db.prepare(
      'INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)'
    ).run(
      'msg-e2e',
      'e2e-opencode-session',
      BASE,
      BASE + 8_000,
      JSON.stringify({
        role: 'assistant',
        providerID: 'openai',
        modelID: 'gpt-5.5',
        tokens: { input: 1_000, output: 400, reasoning: 0, cache: { read: 0 } },
        time: { created: BASE, completed: BASE + 8_000 }
      })
    )
    db.close()

    await postHook(electronApp, 'opencode', descriptor, {
      hook_event_name: 'SessionIdle',
      sessionID: 'e2e-opencode-session'
    })

    const readout = orcaPage.getByLabel('Agent throughput, 50 tok/s')
    await expect(readout).toBeVisible()
    await expect(readout).toHaveText('50 tok/s')
    await expectTooltip(
      orcaPage,
      readout,
      [
        'In the bar: 50 tok/s, this turn’s average over 1 model response(s)',
        'Last request: 50 tok/s (400 tokens in 8.0s)',
        'OpenCode · openai/gpt-5.5'
      ],
      'after-opencode-tooltip'
    )
  })
})
