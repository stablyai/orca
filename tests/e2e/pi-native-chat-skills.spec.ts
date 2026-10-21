import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import {
  createStructuredAgentSessionId,
  structuredAgentSessionCreateParams
} from '../../src/shared/structured-agent-session-create'

// Pi's terminal transcripts have no chat reader; the menu belongs to its structured RPC chat.
const RPC_FIXTURE = `
const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline')
if (process.argv.includes('--version')) { console.log('1.2.0'); process.exit(0) }
const sessionFile = path.join(__dirname, 'session.jsonl')
const requestLog = path.join(__dirname, 'requests.jsonl')
const model = { provider: 'fixture', id: 'fixture', name: 'Pi fixture', reasoning: false }
fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id: 'fixture', cwd: process.cwd() }) + '\\n')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line)
  fs.appendFileSync(requestLog, line + '\\n')
  const replies = {
    get_state: { model, sessionFile, isStreaming: false, isCompacting: false },
    get_available_models: { models: [model] },
    get_commands: { commands: [{ name: 'skill:fixture-review', source: 'skill', description: 'Pi RPC reported skill' }] },
    prompt: { disposition: 'handled' },
    get_messages: { messages: [] },
    get_entries: { entries: [], leafId: null },
    get_tree: { tree: [], leafId: null }
  }
  console.log(JSON.stringify({ id: request.id, type: 'response', command: request.type, success: true, data: replies[request.type] ?? {} }))
})
`

test('Pi chat lists a discovered skill and inserts its Pi invocation', async ({
  orcaPage,
  electronApp,
  testRepoPath
}, testInfo) => {
  test.skip(process.platform === 'win32', 'the isolated Pi RPC wrapper uses a POSIX shell')
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)

  const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const skillDirectory = path.join(isolatedHome, '.pi', 'agent', 'skills', 'fixture-review')
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(
    path.join(skillDirectory, 'SKILL.md'),
    '---\nname: fixture-review\ndescription: Review with the Pi fixture skill\n---\n\nReview the changes.\n'
  )
  const fixtureDirectory = path.join(isolatedHome, 'pi-rpc-fixture')
  mkdirSync(fixtureDirectory)
  const script = path.join(fixtureDirectory, 'pi-rpc.cjs')
  const command = path.join(fixtureDirectory, 'pi')
  writeFileSync(script, RPC_FIXTURE)
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`
  writeFileSync(command, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} "$@"\n`)
  chmodSync(command, 0o755)
  await orcaPage.evaluate(async (override) => {
    await window.__store?.getState().updateSettings({
      experimentalNativeChat: true,
      agentCmdOverrides: { pi: override }
    })
  }, buildFakeAgentCommandOverride(command))

  const sessionId = createStructuredAgentSessionId('pi', randomUUID)
  const params = structuredAgentSessionCreateParams({
    sessionId,
    worktree: `id:${worktreeId}`,
    agent: 'pi',
    firstMessage: {
      clientMessageId: randomUUID(),
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'Initialize the isolated Pi fixture' }]
      }
    },
    randomUuid: randomUUID
  })
  const created = await orcaPage.evaluate(
    (input) => window.api.runtime.call({ method: 'agentSession.create', params: input }),
    params
  )
  expect(created, JSON.stringify(created)).toMatchObject({ ok: true })
  await expect
    .poll(() =>
      orcaPage.evaluate(
        ({ workspace, session }) =>
          window.__store
            ?.getState()
            .unifiedTabsByWorktree[workspace]?.some(
              (tab) => tab.contentType === 'agent-session' && tab.entityId === session
            ),
        { workspace: worktreeId, session: sessionId }
      )
    )
    .toBe(true)
  const tabId = await orcaPage.evaluate(
    ({ workspace, session }) =>
      window.__store
        ?.getState()
        .unifiedTabsByWorktree[workspace]?.find(
          (tab) => tab.contentType === 'agent-session' && tab.entityId === session
        )?.id,
    { workspace: worktreeId, session: sessionId }
  )
  if (!tabId) {
    throw new Error('Created Pi session has no published tab')
  }
  await orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${tabId}"]`).click()

  await expect
    .poll(() =>
      orcaPage.evaluate(
        (session) =>
          window.api.runtime.call({
            method: 'agentSession.commands',
            params: { sessionId: session }
          }),
        sessionId
      )
    )
    .toMatchObject({
      ok: true,
      result: { commands: [{ name: 'skill:fixture-review', kind: 'skill' }] }
    })
  const discovery = await orcaPage.evaluate(
    ({ cwd, workspace }) =>
      window.api.runtime.call({
        method: 'skills.discover',
        params: { cwd, worktreeId: workspace, refresh: true }
      }),
    { cwd: testRepoPath, workspace: worktreeId }
  )
  const discoveryEvidence = testInfo.outputPath('pi-skill-discovery.json')
  mkdirSync(testInfo.outputDir, { recursive: true })
  writeFileSync(discoveryEvidence, JSON.stringify(discovery))
  await testInfo.attach('pi-skill-discovery', {
    path: discoveryEvidence,
    contentType: 'application/json'
  })
  expect(discovery).toMatchObject({
    ok: true,
    result: {
      skills: expect.arrayContaining([
        expect.objectContaining({
          name: 'fixture-review',
          skillFilePath: path.join(skillDirectory, 'SKILL.md')
        })
      ])
    }
  })

  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(chat).toBeVisible()
  const composer = chat.getByRole('textbox')
  await expect(composer).toBeVisible()
  await expect(composer).toBeEditable()
  await composer.click()
  await orcaPage.keyboard.type('/fixture-review')
  await expect(composer).toHaveText('/fixture-review')
  const picker = orcaPage.locator('[role="listbox"][id^="native-chat-picker-"]')
  await expect(picker).toBeVisible()
  const skill = picker.getByRole('option', { name: /fixture-review/ })
  await expect(skill).toBeVisible()
  await expect(skill).toContainText('/skill:fixture-review')
  await expect(skill).toContainText('Review with the Pi fixture skill')
  expect(readFileSync(path.join(fixtureDirectory, 'requests.jsonl'), 'utf8')).toContain(
    '"type":"get_commands"'
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('pi-skill-menu.png') })

  await orcaPage.keyboard.press('Enter')
  await expect(composer.locator('[data-native-chat-skill]')).toHaveAttribute(
    'data-native-chat-skill',
    '/skill:fixture-review'
  )
  await expect(picker).toHaveCount(0)
  await orcaPage.screenshot({ path: testInfo.outputPath('pi-skill-inserted.png') })

  await orcaPage.keyboard.type('confirm')
  await orcaPage.keyboard.press('Enter')
  const requestLog = path.join(fixtureDirectory, 'requests.jsonl')
  await expect
    .poll(() => readFileSync(requestLog, 'utf8'))
    .toContain('"message":"/skill:fixture-review confirm"')
  const rpcEvidence = testInfo.outputPath('pi-rpc-requests.jsonl')
  writeFileSync(rpcEvidence, readFileSync(requestLog))
  await testInfo.attach('pi-rpc-requests', {
    path: rpcEvidence,
    contentType: 'application/x-ndjson'
  })
  await orcaPage.screenshot({ path: testInfo.outputPath('pi-skill-sent.png') })
})
