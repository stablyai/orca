import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import {
  enableNativeChatSetting,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

// UUIDv7 session id so the Muse hook's log lookup parses it like a real log.
const MUSE_SESSION_ID = '019a2f3c-4d5e-7f01-8a2b-3c4d5e6f7890'
const USER_PROMPT = 'MUSEE2E user prompt: summarize the probe plan'
const ASSISTANT_TEXT = 'MUSEE2E assistant reply: starting the probe steps'
const TOOL_ARGS_MARKER = 'MUSEE2E-probe-ls'
const TOOL_OUTPUT = 'MUSEE2E tool output: probe-ok'
const QUESTION_TEXT = 'MUSEE2E question: proceed with deploy?'
const QUESTION_OPTION = 'MUSEE2E-Yes'
const ANSWER_TEXT = 'MUSEE2E answer: shipped it'
const LIVE_FOLLOWUP = 'MUSEE2E live followup: tail reached the chat'
const INTERRUPTED_TEXT = 'Conversation interrupted'
const HIDDEN_STATUS = 'MUSEE2E-HIDDEN-STATUS-MUST-NOT-RENDER'
const HIDDEN_FAILED = 'MUSEE2E-FAILED-MUST-NOT-RENDER'

const BASE_RECORDED_AT = Date.now() * 1000

function museLine(
  sequence: number,
  payloadType: string,
  payload: Record<string, unknown>,
  extra: Record<string, unknown> = {}
): string {
  return `${JSON.stringify({
    schema_version: 1,
    id: `e2e-rec-${sequence}`,
    stream: { kind: 'session', id: MUSE_SESSION_ID },
    sequence,
    recorded_at: BASE_RECORDED_AT + sequence * 1_000_000,
    record_type: 'event',
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
    ...extra
  })}\n`
}

function runEvent(sequence: number, event: Record<string, unknown>): string {
  return museLine(sequence, 'runtime.session', { kind: 'run', run_id: 'e2e-run-1', event })
}

/** A Muse session covering every native-chat row kind plus bookkeeping that must not render. */
function museTranscriptFixture(): string {
  return [
    museLine(1, 'runtime.user_intent.accepted', {
      refill_blocks: [{ kind: 'text', text: USER_PROMPT }]
    }),
    runEvent(2, { kind: 'assistant_message_committed', text: ASSISTANT_TEXT }),
    runEvent(3, {
      kind: 'assistant_tool_calls_committed',
      tool_calls: [
        { name: 'bash', args: `{"command":"${TOOL_ARGS_MARKER} --flag"}`, call_id: 'call-e2e-1' }
      ]
    }),
    runEvent(4, {
      kind: 'tool_result_batch_committed',
      results: [{ text: TOOL_OUTPUT, tool_call_id: 'call-e2e-1' }]
    }),
    runEvent(5, {
      kind: 'user_input_prompt_requested',
      prompt_id: 'e2e-prompt-1',
      questions: [
        {
          header: 'MUSEE2E Deploy',
          question: QUESTION_TEXT,
          options: [{ label: QUESTION_OPTION }, { label: 'MUSEE2E-No' }]
        }
      ]
    }),
    runEvent(6, {
      kind: 'user_input_prompt_settled',
      prompt_id: 'e2e-prompt-1',
      outcome: 'answered',
      answers: [{ id: 'deploy', selected_label: ANSWER_TEXT }]
    }),
    runEvent(7, { kind: 'terminal', terminal: 'cancelled', reason: 'e2e probe interrupt' }),
    // Bookkeeping below: none of it may render.
    runEvent(8, { kind: 'status', text: HIDDEN_STATUS }),
    runEvent(9, { kind: 'failed', reason: HIDDEN_FAILED, task_id: 'task-e2e-1' }),
    museLine(10, 'run.model.configured', { record: { model_id: 'e2e-model' } }),
    `${JSON.stringify({ retained_frame: 'session_permission_transaction', children: [] })}\n`
  ].join('')
}

test('Muse native chat renders every transcript row kind and follows live appends', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  const startedAt = Date.now()
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  // Why: the Muse sessions root derives from XDG_DATA_HOME, which the harness
  // leaves ambient. Pin it to the isolated home so resolution can only read
  // this test's fixture, never the developer's live Muse logs.
  const isolatedDataHome = path.join(home, '.local', 'share')
  // Why: Electron's evaluate passes its API as the first function arg, so the
  // fixture value arrives second — reading it first would pin the object.
  await electronApp.evaluate((electron, dataHome) => {
    void electron
    process.env.XDG_DATA_HOME = dataHome
  }, isolatedDataHome)
  const resolvedDataHome = await electronApp.evaluate(() => process.env.XDG_DATA_HOME)
  expect(resolvedDataHome).toBe(isolatedDataHome)

  const sessionDir = path.join(
    isolatedDataHome,
    'muse',
    'sessions',
    '2026',
    '10',
    '21',
    MUSE_SESSION_ID
  )
  mkdirSync(sessionDir, { recursive: true })
  const sessionFile = path.join(sessionDir, 'session.jsonl')
  writeFileSync(sessionFile, museTranscriptFixture())

  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  await enableNativeChatSetting(orcaPage)
  const endpoint = await readHookEndpoint(electronApp)
  const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/muse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': endpoint.token
    },
    body: JSON.stringify({
      ...descriptor,
      tabId,
      env: endpoint.env,
      version: endpoint.version,
      payload: {
        hook_event_name: 'UserPromptSubmit',
        session_id: MUSE_SESSION_ID,
        turn_id: 'e2e-turn-1',
        transcript_path: null,
        model: 'muse-spark-e2e'
      }
    })
  })
  expect(response.status).toBe(204)
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          (paneKey) => window.__store?.getState().agentStatusByPaneKey[paneKey]?.agentType,
          descriptor.paneKey
        ),
      { timeout: 15_000 }
    )
    .toBe('muse')
  await expect
    .poll(
      () =>
        orcaPage.evaluate(
          (paneKey) =>
            window.__store?.getState().agentStatusByPaneKey[paneKey]?.providerSession?.id,
          descriptor.paneKey
        ),
      { timeout: 15_000 }
    )
    .toBe(MUSE_SESSION_ID)

  await orcaPage.screenshot({ path: testInfo.outputPath('01-terminal-before-chat.png') })
  const toggleStartedAt = Date.now()
  await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(chat).toBeVisible({ timeout: 15_000 })
  const toggleVisibleMs = Date.now() - toggleStartedAt

  // Each transcript row kind, observed separately.
  await expect(chat.getByText(USER_PROMPT, { exact: true })).toBeVisible({ timeout: 30_000 })
  // Why: the assistant/tool rows fold under the settled turn bar like every
  // agent's work detail; expand it before asserting the folded rows.
  await chat.locator('button[data-native-chat-turn-status="settled"]').first().click()
  await expect(chat.getByText(ASSISTANT_TEXT, { exact: true })).toBeVisible({ timeout: 10_000 })
  // Why: the call owns its output behind two disclosures (run, then member
  // detail), like every agent's tool run; expand both before asserting.
  const toolRun = chat.locator('[data-native-chat-tool-run-state]').first()
  await expect(toolRun).toBeVisible({ timeout: 10_000 })
  if ((await toolRun.getAttribute('aria-expanded')) !== 'true') {
    await toolRun.click()
  }
  await expect(toolRun).toHaveAttribute('aria-expanded', 'true')
  const members = chat.locator('[data-native-chat-tool-run-members]').first()
  await expect(members).toBeVisible()
  const callLine = members.getByRole('button', { name: /MUSEE2E-probe-ls/ })
  await expect(callLine).toBeVisible()
  await callLine.click()
  const detail = callLine.locator('..')
  await expect(detail.getByText(TOOL_OUTPUT, { exact: true })).toBeVisible({ timeout: 10_000 })
  await expect(chat.getByText(TOOL_ARGS_MARKER).first()).toBeVisible({ timeout: 10_000 })
  // Why: the card head joins header and prompt in one text block, so the
  // question matches as a substring of the rendered card.
  await expect(chat.getByText(QUESTION_TEXT)).toBeVisible({ timeout: 10_000 })
  await expect(chat.getByText(QUESTION_OPTION, { exact: true }).first()).toBeVisible()
  await expect(chat.getByText(ANSWER_TEXT, { exact: true })).toBeVisible()
  await expect(chat.getByText(INTERRUPTED_TEXT, { exact: true })).toBeVisible()
  await expect(chat.getByText(HIDDEN_STATUS, { exact: true })).toHaveCount(0)
  await expect(chat.getByText(HIDDEN_FAILED, { exact: true })).toHaveCount(0)
  const transcriptText = await chat.innerText()
  expect(transcriptText.indexOf(USER_PROMPT)).toBeLessThan(transcriptText.indexOf(ASSISTANT_TEXT))
  expect(transcriptText.indexOf(ASSISTANT_TEXT)).toBeLessThan(transcriptText.indexOf(TOOL_OUTPUT))
  await orcaPage.screenshot({ path: testInfo.outputPath('02-chat-full.png') })

  // Scroll round-trip proves the rendered rows stay stable off the live edge.
  await chat.getByText(USER_PROMPT, { exact: true }).scrollIntoViewIfNeeded()
  await orcaPage.screenshot({ path: testInfo.outputPath('03-chat-scrolled-top.png') })
  await chat.getByText(INTERRUPTED_TEXT, { exact: true }).scrollIntoViewIfNeeded()

  const appendStartedAt = Date.now()
  appendFileSync(
    sessionFile,
    runEvent(11, { kind: 'assistant_message_committed', text: LIVE_FOLLOWUP })
  )
  await expect(chat.getByText(LIVE_FOLLOWUP, { exact: true })).toBeVisible({ timeout: 15_000 })
  const liveVisibleMs = Date.now() - appendStartedAt
  await orcaPage.screenshot({ path: testInfo.outputPath('04-live-update.png') })

  const totalMs = Date.now() - startedAt
  console.log(
    `[muse-e2e] toggle-to-chat-visible=${toggleVisibleMs}ms live-append-visible=${liveVisibleMs}ms total=${totalMs}ms`
  )
  expect(toggleVisibleMs).toBeLessThan(30_000)
  expect(liveVisibleMs).toBeLessThan(15_000)
})
