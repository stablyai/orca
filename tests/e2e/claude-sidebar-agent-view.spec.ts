import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  sendToTerminal,
  waitForTerminalOutput
} from './helpers/terminal'
import { dismissSetupScriptPrompts } from './helpers/sidebar-setup-prompt'
import { readHookEndpoint } from './helpers/agent-hook-endpoint'
import { readAgentProcess } from '../../src/shared/agent-process-presence-probe'
import { retentionFixtureCommand } from './helpers/host-created-terminal-retention-oracle'

const SESSION = '11111111-2222-4333-8444-555555555555'
const CHILD = 'sidebar-proof-child-id'

test('sidebar child and parent clicks reach the exact Claude session without submitting a draft', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  test.skip(process.platform === 'win32', 'The PTY fixture uses POSIX raw mode')
  const dir = mkdtempSync(join(tmpdir(), 'orca-sidebar-view-'))
  registerPostElectronShutdownCleanup(async () => rmSync(dir, { recursive: true, force: true }))
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  const endpoint = await readHookEndpoint(electronApp)
  const fixture = join(dir, 'claude-fixture.mjs')
  const sink = join(dir, 'events.jsonl')
  writeFileSync(
    fixture,
    `
import {appendFileSync} from 'node:fs'
process.title = 'claude'
const sink = process.argv[2]
const endpoint = ${JSON.stringify(endpoint)}
const identity = {paneKey:${JSON.stringify(descriptor.paneKey)},sessionId:${JSON.stringify(SESSION)},instanceId:'test-mod-instance'}
let agentId
let revision=1
const record = value => appendFileSync(sink, JSON.stringify(value)+'\\n')
const post = async (action, extra={}) => (await fetch('http://127.0.0.1:'+endpoint.port+'/claude/agent-view',{method:'POST',headers:{'content-type':'application/json','x-orca-agent-hook-token':endpoint.token},body:JSON.stringify({...identity,action,...extra})})).json()
const register=()=>post('register',{keybindings:JSON.stringify({bindings:[{context:'Chat',bindings:{'ctrl+alt+g':'command:orca-agent-view'}}]}),view:{agentId,revision}})
await register()
setInterval(register,5000)
process.stdin.setRawMode(true)
record({ready:process.pid})
process.stdout.write('Claude view fixture ready\\r\\n')
let draft='ORCA_KEEP_DRAFT'
process.stdin.on('data',async bytes=>{
 const text=bytes.toString()
 if(text==='\\x1b[103;7u') {
  const request=await post('take')
  if(!request.requestId)return
  record({view:request.agentId||'main',draft})
  agentId=request.agentId
  await post('observe',{view:{agentId,revision:++revision}})
  process.stdout.write('Viewing '+(request.agentId||'main')+' draft='+draft+'\\r\\n')
  await post('ack',{requestId:request.requestId})
 } else if(text==='\x0b') {
  agentId=agentId?undefined:${JSON.stringify(CHILD)}
  await post('observe',{view:{agentId,revision:++revision}})
 } else {record({unexpected:text});draft+=text}
})
process.stdin.resume()
`
  )
  await execInTerminal(orcaPage, ptyId, retentionFixtureCommand(fixture, sink))
  const events = () => {
    try {
      return readFileSync(sink, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    } catch {
      return []
    }
  }
  await expect.poll(() => events()[0]?.ready).toBeTruthy()
  const pid = events()[0].ready
  const processIdentity = await readAgentProcess(pid)
  if (processIdentity.verdict !== 'live') {
    throw new Error('Fixture process must be verifiable')
  }
  const postHook = async (payload: Record<string, unknown>) => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/hook/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orca-agent-hook-token': endpoint.token },
      body: JSON.stringify({
        ...descriptor,
        tabId: descriptor.paneKey.split(':')[0],
        env: endpoint.env,
        version: endpoint.version,
        agentProcess: { pid, platform: process.platform, startTime: processIdentity.startTime },
        payload: { session_id: SESSION, ...payload }
      })
    })
    expect(response.status).toBe(204)
  }
  await postHook({ hook_event_name: 'UserPromptSubmit', prompt: 'Sidebar parent proof' })
  await postHook({ hook_event_name: 'SubagentStart', agent_id: CHILD, agent_type: 'Explore' })
  await postHook({
    hook_event_name: 'Stop',
    background_tasks: [
      {
        id: CHILD,
        type: 'subagent',
        status: 'running',
        description: 'Sidebar child proof',
        agent_type: 'Explore'
      }
    ]
  })
  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    if (!state.worktreeCardProperties.includes('inline-agents')) {
      state.setWorktreeCardProperties([...state.worktreeCardProperties, 'inline-agents'])
    }
  })
  await dismissSetupScriptPrompts(orcaPage)
  const sidebar = orcaPage.locator('[data-worktree-sidebar]').first()
  const parent = sidebar
    .locator('.compact-agent-row')
    .filter({ hasText: 'Sidebar parent proof' })
    .first()
  await expect(parent).toBeVisible({ timeout: 15000 })
  const disclosure = parent.locator('[data-agent-child-disclosure-button]')
  if ((await disclosure.getAttribute('aria-expanded')) !== 'true') {
    await disclosure.click()
  }
  const child = sidebar
    .locator('.compact-agent-row')
    .filter({ hasText: 'Sidebar child proof' })
    .last()
  await expect(child).toBeVisible()
  await expect(parent).toHaveAttribute('aria-current', 'true')
  await orcaPage.mouse.move(20, 20)
  await expect(
    orcaPage.getByRole('tooltip').filter({ hasText: 'Workspace board moved to the bottom bar' })
  ).toBeHidden({ timeout: 20000 })
  await orcaPage.screenshot({
    path: testInfo.outputPath('before-agent-navigation.png'),
    animations: 'disabled'
  })
  await parent.click()
  await expect(parent).toHaveAttribute('aria-current', 'true')
  expect(events().filter((event) => event.view)).toEqual([])
  await child.click()
  await expect
    .poll(() => events().find((event) => event.view === CHILD))
    .toEqual({ view: CHILD, draft: 'ORCA_KEEP_DRAFT' })
  await waitForTerminalOutput(orcaPage, `Viewing ${CHILD} draft=ORCA_KEEP_DRAFT`)
  await expect(child).toHaveAttribute('aria-current', 'true')
  await expect(parent).not.toHaveAttribute('aria-current')
  await child.click()
  await expect(child).toHaveAttribute('aria-current', 'true')
  expect(events().filter((event) => event.view)).toHaveLength(1)
  await orcaPage.screenshot({
    path: testInfo.outputPath('after-child-navigation.png'),
    animations: 'disabled'
  })
  await parent.click()
  await expect
    .poll(() => events().find((event) => event.view === 'main'))
    .toEqual({ view: 'main', draft: 'ORCA_KEEP_DRAFT' })
  await expect(parent).toHaveAttribute('aria-current', 'true')
  await expect(child).not.toHaveAttribute('aria-current')
  await sendToTerminal(orcaPage, ptyId, '\x0b')
  await expect(child).toHaveAttribute('aria-current', 'true')
  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await expect(child.locator('xpath=ancestor::*[@inert]')).toHaveCount(1)
  await expect(parent.getByLabel('Viewing subagent Sidebar child proof')).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('collapsed-child-indicator.png') })
  await disclosure.click()
  await sendToTerminal(orcaPage, ptyId, '\x0b')
  await expect(parent).toHaveAttribute('aria-current', 'true')
  expect(events().filter((event) => event.unexpected)).toEqual([])
  await orcaPage.evaluate(() => window.__store!.getState().setAgentActivityDisplayMode('full'))
  const fullChild = sidebar
    .locator('[role="treeitem"]')
    .filter({ hasText: 'Sidebar child proof' })
    .last()
  await fullChild.click()
  await expect.poll(() => events().filter((event) => event.view === CHILD).length).toBe(2)
  await expect(fullChild).toHaveAttribute('aria-current', 'true')
  const fullParent = sidebar
    .locator('.agent-disclosure-row')
    .filter({ hasText: 'Sidebar parent proof' })
    .first()
  await fullParent.click()
  await expect.poll(() => events().filter((event) => event.view === 'main').length).toBe(2)
  await expect(fullParent).toHaveAttribute('aria-current', 'true')
  expect(
    events()
      .filter((event) => event.view)
      .every((event) => event.draft === 'ORCA_KEEP_DRAFT')
  ).toBe(true)
  expect(events().filter((event) => event.unexpected)).toEqual([])
  await orcaPage.screenshot({ path: testInfo.outputPath('sidebar-agent-navigation.png') })
})
