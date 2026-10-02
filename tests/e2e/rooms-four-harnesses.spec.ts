import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test as base, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const fakeCliDir = mkdtempSync(path.join(tmpdir(), 'orca-rooms-cli-'))
const transcriptDir = path.join(fakeCliDir, 'transcripts')
const grokHome = path.join(fakeCliDir, 'grok-home')
const agents = ['claude', 'openclaude', 'codex', 'grok'] as const

const fakeAgentSource = String.raw`
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const agent = process.env.ORCA_E2E_AGENT
if (process.argv.includes('app-server')) process.exit(1)
const sessionId = 'room-' + agent + '-' + randomUUID()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const source = agent === 'openclaude' ? 'claude' : agent
const transcriptPath = agent === 'grok'
  ? path.join(process.env.GROK_HOME, 'sessions', encodeURIComponent(process.cwd()), sessionId, 'chat_history.jsonl')
  : path.join(process.env.ORCA_E2E_ROOM_TRANSCRIPTS, sessionId + '.jsonl')
fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
fs.writeFileSync(transcriptPath, '')

function refreshEndpoint() {
  if (process.env.ORCA_AGENT_HOOK_PORT && process.env.ORCA_AGENT_HOOK_TOKEN) return
  const endpoint = process.env.ORCA_AGENT_HOOK_ENDPOINT
  if (!endpoint || !fs.existsSync(endpoint)) return
  const text = fs.readFileSync(endpoint, 'utf8')
  for (const key of ['ORCA_AGENT_HOOK_PORT', 'ORCA_AGENT_HOOK_TOKEN']) {
    const match = text.match(new RegExp(key + "=['\"]?([^'\"\\r\\n ]+)"))
    if (match) process.env[key] = match[1]
  }
}

function post(route, fields) {
  refreshEndpoint()
  const port = Number(process.env.ORCA_AGENT_HOOK_PORT)
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  if (!port || !token) return Promise.resolve(false)
  const body = new URLSearchParams(fields).toString()
  return new Promise((resolve) => {
    const request = http.request({
      hostname: '127.0.0.1', port, path: route, method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        'x-orca-agent-hook-token': token
      }
    }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode === 200)) })
    request.on('error', () => resolve(false))
    request.end(body)
  })
}

function hookPayload(eventName, prompt) {
  return {
    hook_event_name: eventName,
    session_id: sessionId,
    sessionId,
    transcript_path: transcriptPath,
    prompt
  }
}

function postHook(eventName, prompt = '') {
  return post('/hook/' + source, {
    paneKey: process.env.ORCA_PANE_KEY || '',
    tabId: process.env.ORCA_TAB_ID || '',
    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || '',
    worktreeId: process.env.ORCA_WORKTREE_ID || '',
    env: process.env.ORCA_AGENT_HOOK_ENV || '',
    version: process.env.ORCA_AGENT_HOOK_VERSION || '',
    agent,
    grokHome: process.env.GROK_HOME || '',
    payload: JSON.stringify(hookPayload(eventName, prompt))
  })
}

function postClaudeContext(usedTokens) {
  if (agent !== 'claude' && agent !== 'openclaude') return Promise.resolve()
  return post('/statusline/claude', {
    paneKey: process.env.ORCA_PANE_KEY || '',
    agent,
    configDir: '',
    payload: JSON.stringify({
      context_window: {
        context_window_size: 1000000,
        current_usage: { input_tokens: usedTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
      }
    })
  })
}

function appendUsage(usedTokens) {
  if (agent === 'codex') {
    fs.appendFileSync(transcriptPath, JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { model_context_window: 258000, last_token_usage: { total_tokens: usedTokens } } }
    }) + '\n')
  }
  if (agent === 'grok') {
    fs.appendFileSync(path.join(path.dirname(transcriptPath), 'updates.jsonl'), JSON.stringify({
      params: { _meta: { totalTokens: usedTokens } }
    }) + '\n')
  }
}

function appendTurn(prompt) {
  const response = agent + ' replied to ROOM_E2E'
  const timestamp = new Date().toISOString()
  const rows = agent === 'codex'
    ? [
        { timestamp, type: 'event_msg', payload: { type: 'user_message', message: prompt } },
        { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: response } }
      ]
    : agent === 'grok'
      ? [
          { id: randomUUID(), timestamp, type: 'user', content: prompt },
          { id: randomUUID(), timestamp, type: 'assistant', content: response }
        ]
      : [
          { sessionId, uuid: randomUUID(), timestamp, type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }] } },
          { sessionId, uuid: randomUUID(), timestamp, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: response }], usage: { input_tokens: 2000 } } }
        ]
  fs.appendFileSync(transcriptPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

async function handlePrompt(prompt) {
  if (prompt.trim() === '/compact') {
    await postHook('PreCompact')
    appendUsage(100)
    await postClaudeContext(100)
    await sleep(100)
    await postHook('PostCompact')
    return
  }
  if (!prompt.includes('ROOM_E2E')) return
  await postHook('UserPromptSubmit', prompt)
  await sleep(300)
  appendTurn(prompt)
  await postHook('Stop', prompt)
}

appendUsage(agent === 'codex' ? 1000 : 3000)
process.stdout.write('\x1b]0;' + agent + ' ready\x07')
const ready = (async () => {
  await sleep(500)
  for (let attempt = 0; attempt < 3; attempt++) {
    await postHook('SessionStart')
    await sleep(250)
  }
  if (agent === 'codex') await postHook('Stop')
  await postClaudeContext(2000)
  process.stdout.write('ROOM_AGENT_READY:' + agent + '\n')
})()

let input = ''
let queue = Promise.resolve()
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  input += chunk
  for (;;) {
    const start = input.indexOf('\x1b[200~')
    const end = input.indexOf('\x1b[201~', start + 6)
    if (start < 0 || end < 0) break
    const prompt = input.slice(start + 6, end)
    input = input.slice(end + 6)
    queue = queue.then(() => ready).then(() => handlePrompt(prompt))
  }
})
process.stdin.resume()
setInterval(() => {}, 60000)
`

writeFileSync(path.join(fakeCliDir, 'fake-room-agent.cjs'), fakeAgentSource)
for (const agent of agents) {
  if (process.platform === 'win32') {
    writeFileSync(
      path.join(fakeCliDir, `${agent}.cmd`),
      `@echo off\r\nset ORCA_E2E_AGENT=${agent}\r\n"${process.execPath}" "%~dp0\\fake-room-agent.cjs" %*\r\n`
    )
  } else {
    const executable = path.join(fakeCliDir, agent)
    writeFileSync(
      executable,
      `#!/bin/sh\nORCA_E2E_AGENT=${agent} exec "${process.execPath}" "${path.join(fakeCliDir, 'fake-room-agent.cjs')}" "$@"\n`
    )
    chmodSync(executable, 0o755)
  }
}

const test = base.extend({
  launchEnv: [
    {
      PATH: `${fakeCliDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_E2E_ROOM_TRANSCRIPTS: transcriptDir,
      GROK_HOME: grokHome
    },
    { option: true }
  ]
})

async function addAgent(page: Page, agent: (typeof agents)[number]): Promise<void> {
  await page.locator('header').getByRole('button', { name: 'Agent', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Add agent' })
  await dialog.getByLabel('Harness').selectOption(agent)
  await dialog.getByLabel('Room identity').fill(agent)
  await dialog.getByRole('button', { name: 'Add agent' }).click()
  await page.waitForTimeout(1_000)
  const errors = await page.locator('[data-sonner-toast]').allTextContents()
  if (errors.length) {
    throw new Error(errors.join(' | '))
  }
  await expect(dialog).toBeHidden({ timeout: 30_000 })
  await expect(page.locator('header').getByText(`@${agent}`, { exact: true })).toBeVisible()
}

test.afterAll(() => rmSync(fakeCliDir, { recursive: true, force: true }))

test('runs a live room through Claude, OpenClaude, Codex, and Grok harnesses', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await orcaPage.getByRole('button', { name: 'Rooms', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Create room' }).click()
  await expect(orcaPage.getByTestId('rooms-page')).toBeVisible()

  for (const agent of agents) {
    await addAgent(orcaPage, agent)
  }

  await orcaPage
    .getByPlaceholder('Message the room — use @agent to invite a response')
    .fill('@all ROOM_E2E')
  await orcaPage.getByRole('button', { name: 'Send', exact: true }).click()
  for (const agent of agents) {
    await expect(orcaPage.getByText(`${agent} replied to ROOM_E2E`, { exact: true })).toBeVisible({
      timeout: 30_000
    })
    const card = orcaPage.locator('header').getByText(`@${agent}`, { exact: true }).locator('..')
    await expect(card).not.toContainText('context unavailable')
    await orcaPage.getByRole('button', { name: `Compact ${agent}` }).click()
    await expect(card).toContainText('compacted', { timeout: 30_000 })
  }
})
