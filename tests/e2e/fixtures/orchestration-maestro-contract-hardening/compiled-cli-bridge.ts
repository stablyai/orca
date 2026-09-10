import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../../../src/cli/runtime-client'
import { buildFakeAgentCommandOverride } from '../../helpers/fake-agent-command-override'
import { waitForActivePaneHookDescriptor } from '../../helpers/terminal'

export type CompiledCliResult<Result> = {
  status: number
  stderr: string
  response: { ok: true; result: Result } | { ok: false; error: { code: string; message: string } }
}

type CliBridge = {
  terminalHandle: string
  invoke<Result>(
    args: readonly string[],
    options?: { cwd?: string; input?: string }
  ): Promise<CompiledCliResult<Result>>
  close(): Promise<void>
}

function coordinatorSource(root: string, cliEntry: string, userDataDir: string): string {
  return `#!/usr/bin/env node
const { existsSync, readdirSync, readFileSync, writeFileSync } = require('node:fs')
const { spawnSync } = require('node:child_process')
const { join } = require('node:path')
const root = ${JSON.stringify(root)}
const cliEntry = ${JSON.stringify(cliEntry)}
const userDataDir = ${JSON.stringify(userDataDir)}
const claimed = new Set()
async function attestCoordinator() {
  const port = process.env.ORCA_AGENT_HOOK_PORT
  const token = process.env.ORCA_AGENT_HOOK_TOKEN
  const launchToken = process.env.ORCA_AGENT_LAUNCH_TOKEN
  if (!port || !token || !launchToken) throw new Error('Coordinator hook authority is unavailable')
  for (const hookEventName of ['SessionStart', 'UserPromptSubmit']) {
    if (hookEventName === 'UserPromptSubmit') {
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const response = await fetch('http://127.0.0.1:' + port + '/hook/codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: process.env.ORCA_PANE_KEY,
        tabId: process.env.ORCA_TAB_ID,
        worktreeId: process.env.ORCA_WORKTREE_ID,
        launchToken,
        env: process.env.ORCA_AGENT_HOOK_ENV || 'development',
        version: process.env.ORCA_AGENT_HOOK_VERSION || '1',
        payload: { hook_event_name: hookEventName, prompt: 'Run compiled Orca CLI checks' }
      })
    })
    if (!response.ok) throw new Error('Coordinator hook attestation failed: ' + response.status)
  }
}
setInterval(() => {
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith('.request.json') || claimed.has(entry)) continue
    claimed.add(entry)
    const id = entry.slice(0, -'.request.json'.length)
    const resultPath = join(root, id + '.result.json')
    try {
      const request = JSON.parse(readFileSync(join(root, entry), 'utf8'))
      const child = spawnSync(process.execPath, [cliEntry, ...request.args], {
        cwd: request.cwd,
        input: request.input,
        encoding: 'utf8',
        env: {
          ...process.env,
          ORCA_USER_DATA_PATH: userDataDir,
          ORCA_DEV_CLI_INVOCATION: '1'
        }
      })
      writeFileSync(resultPath, JSON.stringify({ status: child.status, stdout: child.stdout, stderr: child.stderr }))
    } catch (error) {
      writeFileSync(resultPath, JSON.stringify({ status: 1, stdout: '', stderr: String(error) }))
    }
  }
}, 50)
process.stdout.write('\u001b]0;Codex Ready\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
attestCoordinator().then(() => {
  writeFileSync(join(root, 'coordinator-live.json'), JSON.stringify({
    pid: process.pid,
    terminalHandle: process.env.ORCA_TERMINAL_HANDLE,
    paneKey: process.env.ORCA_PANE_KEY
  }))
  process.stdout.write('OCH coordinator ready\\n')
}).catch((error) => {
  process.stderr.write(String(error) + '\\n')
  process.exit(1)
})
process.stdin.resume()
`
}

function writeCoordinatorExecutable(root: string, source: string): string {
  mkdirSync(root, { recursive: true })
  const sourcePath = path.join(root, 'coordinator.cjs')
  writeFileSync(sourcePath, source)
  if (process.platform === 'win32') {
    const executablePath = path.join(root, 'coordinator.cmd')
    writeFileSync(executablePath, '@echo off\r\nnode "%~dp0\\coordinator.cjs" %*\r\n')
    return executablePath
  }
  chmodSync(sourcePath, 0o755)
  return sourcePath
}

function parseResponse<Result>(raw: string): CompiledCliResult<Result>['response'] {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || !('ok' in parsed)) {
    throw new Error(`Compiled CLI returned a non-envelope response: ${raw}`)
  }
  return parsed as CompiledCliResult<Result>['response']
}

export async function startCompiledCliBridge(args: {
  page: Page
  root: string
  userDataDir: string
}): Promise<CliBridge> {
  rmSync(args.root, { recursive: true, force: true })
  const cliEntry = path.resolve('out/cli/index.js')
  const executablePath = writeCoordinatorExecutable(
    args.root,
    coordinatorSource(args.root, cliEntry, args.userDataDir)
  )
  const command = buildFakeAgentCommandOverride(executablePath)
  await args.page.evaluate(async (agentCommand) => {
    await window.__store?.getState().updateSettings({
      defaultTuiAgent: 'codex',
      agentCmdOverrides: { codex: agentCommand },
      agentDefaultArgs: { codex: '' },
      disabledTuiAgents: []
    })
  }, command)
  await args.page.getByRole('button', { name: 'New tab' }).click()
  await args.page
    .getByRole('menuitem', { name: /^Codex(?:\s|$)/ })
    .first()
    .click()

  const livePath = path.join(args.root, 'coordinator-live.json')
  await expect.poll(() => existsSync(livePath), { timeout: 30_000 }).toBe(true)
  const live = JSON.parse(readFileSync(livePath, 'utf8')) as {
    terminalHandle?: string
    paneKey?: string
  }
  const pane = await waitForActivePaneHookDescriptor(args.page)
  const client = new RuntimeClient(args.userDataDir, 30_000, null, null)
  const resolved = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey: pane.paneKey
  })
  expect(resolved.result.terminal.handle).toBe(live.terminalHandle)
  expect(pane.paneKey).toBe(live.paneKey)
  await expect
    .poll(() =>
      args.page.evaluate((paneKey) => {
        const status = window.__store?.getState().agentStatusByPaneKey[paneKey]
        return Boolean(status)
      }, pane.paneKey)
    )
    .toBe(true)

  return {
    terminalHandle: resolved.result.terminal.handle,
    async invoke<Result>(commandArgs, options = {}) {
      const requestId = randomUUID()
      const requestPath = path.join(args.root, `${requestId}.request.json`)
      const resultPath = path.join(args.root, `${requestId}.result.json`)
      writeFileSync(
        requestPath,
        JSON.stringify({
          args: commandArgs,
          cwd: options.cwd ?? process.cwd(),
          input: options.input
        })
      )
      await expect.poll(() => existsSync(resultPath), { timeout: 60_000 }).toBe(true)
      const result = JSON.parse(readFileSync(resultPath, 'utf8')) as {
        status: number
        stdout: string
        stderr: string
      }
      return {
        status: result.status,
        stderr: result.stderr,
        response: parseResponse<Result>(result.stdout)
      }
    },
    async close() {
      await client
        .call('terminal.close', { terminal: resolved.result.terminal.handle })
        .catch(() => undefined)
      rmSync(args.root, { recursive: true, force: true })
    }
  }
}
