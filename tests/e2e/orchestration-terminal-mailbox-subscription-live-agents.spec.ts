import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import type { TuiAgent } from '../../src/shared/tui-agent'
import { test, expect } from './helpers/orca-app'
import { mailDisposition, readMailRow } from './helpers/orchestration-mail-store'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal-pane-operations'

const RUN_LIVE_AGENTS = process.env.ORCA_E2E_LIVE_MAILBOX_AGENTS === '1'
const CLI_ENTRY = path.join(process.cwd(), 'out', 'cli', 'index.js')

test.use({ orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: '600000' } })

type LiveAgentCase = {
  agent: Extract<TuiAgent, 'codex' | 'claude'>
  command: (credentialDir: string | null, prompt: string) => string
  promptAtLaunch: boolean
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function claudeTrustBootstrap(home: string): string {
  const source = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const file=path.join(process.env.HOME,'.claude.json')",
    "const data=JSON.parse(fs.readFileSync(file,'utf8'))",
    'data.projects??={}',
    'data.projects[process.cwd()]={...(data.projects[process.cwd()]||{}),hasTrustDialogAccepted:true}',
    "fs.writeFileSync(file,JSON.stringify(data,null,2)+'\\n')"
  ].join(';')
  return `${shellQuote(process.execPath)} -e ${shellQuote(source)} && exec ${shellQuote(path.join(home, '.local', 'bin', 'claude'))} --dangerously-skip-permissions`
}

function removeClaudeTestTrust(worktreePath: string): void {
  const file = path.join(homedir(), '.claude.json')
  const data: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (!isRecord(data) || !isRecord(data.projects) || !data.projects[worktreePath]) {
    return
  }
  delete data.projects[worktreePath]
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

function liveAgentCases(): LiveAgentCase[] {
  const home = homedir()
  return [
    {
      agent: 'codex',
      promptAtLaunch: false,
      command: (credentialDir) => {
        if (!credentialDir) {
          throw new Error('Codex requires an isolated credential directory')
        }
        const prepare = `${shellQuote(process.execPath)} ${shellQuote(CLI_ENTRY)} agent hooks prepare-codex >/dev/null 2>&1`
        const launch = `${shellQuote(path.join(home, '.local', 'bin', 'codex'))} --no-alt-screen --dangerously-bypass-approvals-and-sandbox`
        return [
          '/usr/bin/env',
          `HOME=${shellQuote(home)}`,
          `CODEX_HOME=${shellQuote(credentialDir)}`,
          `ORCA_CODEX_HOME=${shellQuote(credentialDir)}`,
          '/bin/sh',
          '-c',
          shellQuote(`${prepare}; exec ${launch}`)
        ].join(' ')
      }
    },
    {
      agent: 'claude',
      promptAtLaunch: true,
      command: (_, prompt) =>
        [
          '/usr/bin/env',
          `HOME=${shellQuote(home)}`,
          '/bin/sh',
          '-c',
          shellQuote(`${claudeTrustBootstrap(home)} ${shellQuote(prompt)}`)
        ].join(' ')
    }
  ]
}

async function readUserDataDir(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ app }) => app.getPath('userData'))
}

async function readTerminalText(client: RuntimeClient, handle: string): Promise<string> {
  const result = await client.call<{ terminal: { screen?: string; tail?: string[] } }>(
    'terminal.read',
    { terminal: handle, screen: true }
  )
  return result.result.terminal.screen || result.result.terminal.tail?.join('\n') || ''
}

async function readTerminalHistory(client: RuntimeClient, handle: string): Promise<string> {
  const result = await client.call<{ terminal: { tail: string[] } }>('terminal.read', {
    terminal: handle,
    cursor: 0,
    limit: 10_000
  })
  return result.result.terminal.tail.join('\n')
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

test.describe('live terminal mailbox subscription agents', () => {
  test.describe.configure({ timeout: 600_000 })
  test.skip(!RUN_LIVE_AGENTS, 'Set ORCA_E2E_LIVE_MAILBOX_AGENTS=1 to spend provider tokens.')

  for (const live of liveAgentCases()) {
    test(`${live.agent} subscribes and consumes an inbox pointer`, async ({
      orcaPage,
      electronApp
    }) => {
      await waitForSessionReady(orcaPage)
      const activeWorktreeId = await waitForActiveWorktree(orcaPage)
      await ensureTerminalVisible(orcaPage)
      const userDataDir = await readUserDataDir(electronApp)
      const client = new RuntimeClient(userDataDir, 30_000, null, null)
      const active = await client.call<{ worktree: { path: string } }>('worktree.show', {
        worktree: `id:${activeWorktreeId}`
      })
      const before = await client.call<RuntimeTerminalListResult>('terminal.list')
      const existingHandles = new Set(before.result.terminals.map((terminal) => terminal.handle))
      const marker = `${live.agent.toUpperCase()}_${randomUUID().replaceAll('-', '')}`
      const credentialAccountId = live.agent === 'codex' ? randomUUID() : null
      const credentialDir = credentialAccountId
        ? path.join(userDataDir, 'codex-accounts', credentialAccountId, 'home')
        : null
      const subscriptionReceiptPath = path.join(userDataDir, `subscription-${marker}.json`)
      if (credentialDir) {
        mkdirSync(credentialDir, { recursive: true })
        writeFileSync(path.join(credentialDir, '.orca-managed-home'), credentialAccountId!)
        for (const file of ['auth.json', 'config.toml']) {
          const source = path.join(homedir(), '.codex', file)
          if (existsSync(source)) {
            copyFileSync(source, path.join(credentialDir, file))
          }
        }
      }
      const cliPrefix = `ORCA_USER_DATA_PATH=${shellQuote(userDataDir)} ${shellQuote(process.execPath)} ${shellQuote(CLI_ENTRY)}`
      const subscribeCommand = `${cliPrefix} orchestration subscribe --json > ${shellQuote(subscriptionReceiptPath)}`
      const prompt = [
        `Run this shell command: ${subscribeCommand}`,
        `When it finishes, reply exactly SUBSCRIBED_${marker}.`
      ].join(' ')
      const liveCommand = live.command(credentialDir, prompt)
      await orcaPage.evaluate(
        async ({ agent, command }) => {
          await window.__store?.getState().updateSettings({
            agentCmdOverrides: { [agent]: command },
            agentStatusHooksEnabled: true,
            disabledTuiAgents: []
          })
        },
        { agent: live.agent, command: liveCommand }
      )

      let createdTerminalHandle: string | null = null
      let handle: string | null = null
      try {
        await orcaPage.getByRole('button', { name: /^(New tab|새 탭)$/ }).click({ force: true })
        const label = live.agent === 'codex' ? 'Codex' : 'Claude'
        const launch = orcaPage
          .getByRole('menuitem', { name: new RegExp(`^${label}(?:\\s|$)`, 'i') })
          .first()
        await expect(launch).toBeVisible({ timeout: 15_000 })
        await launch.click({ force: true })
        await expect
          .poll(async () => {
            const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
            return (
              listed.result.terminals.find(
                (terminal) => !existingHandles.has(terminal.handle) && terminal.ptyId !== null
              )?.handle ?? null
            )
          })
          .not.toBeNull()
        const launched = await client.call<RuntimeTerminalListResult>('terminal.list')
        const terminal = launched.result.terminals.find(
          (candidate) => !existingHandles.has(candidate.handle) && candidate.ptyId !== null
        )
        handle = terminal?.handle ?? null
        createdTerminalHandle = handle
        if (!handle) {
          throw new Error(`${live.agent} did not publish a terminal handle`)
        }
        await expect
          .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeTabId))
          .toBe(terminal?.tabId)
        await waitForActiveTerminalManager(orcaPage)
        if (live.agent === 'codex') {
          await expect
            .poll(async () => (await readTerminalText(client, handle!)).includes('Do you trust'), {
              timeout: 30_000,
              message: 'Codex did not show the workspace trust prompt'
            })
            .toBe(true)
          await client.call('terminal.send', { terminal: handle, text: '1', enter: true })
        }
        if (!live.promptAtLaunch) {
          await client.call('terminal.send', { terminal: handle, text: prompt, enter: true })
        }
        await expect
          .poll(
            () => {
              if (!existsSync(subscriptionReceiptPath)) {
                return false
              }
              try {
                const receipt: unknown = JSON.parse(readFileSync(subscriptionReceiptPath, 'utf8'))
                return (
                  isRecord(receipt) &&
                  receipt.ok === true &&
                  isRecord(receipt.result) &&
                  receipt.result.subscribed === true
                )
              } catch {
                return false
              }
            },
            {
              timeout: 240_000,
              message: `${live.agent} did not complete subscription`
            }
          )
          .toBe(true)
        await expect
          .poll(
            async () => {
              const status = await client.call<{
                agentStatus: { status: string | null }
              }>('terminal.agentStatus', { terminal: handle })
              return status.result.agentStatus.status
            },
            { timeout: 240_000, message: `${live.agent} did not finish its subscription turn` }
          )
          .toBe('idle')
        await expect
          .poll(
            async () => {
              const idle = await client.call<{ wait: { satisfied: boolean } }>(
                'terminal.wait',
                { terminal: handle, for: 'tui-idle', timeoutMs: 1_000 },
                { timeoutMs: 5_000 }
              )
              return idle.result.wait.satisfied
            },
            { timeout: 60_000, message: `${live.agent} did not reach settled TUI idle` }
          )
          .toBe(true)

        const body = `After reading this message, reply exactly RECEIVED_${marker}.`
        const sent = await client.call<{ message: { id: string } }>('orchestration.send', {
          to: handle,
          from: 'live-agent-e2e',
          subject: `Live ${live.agent} mailbox validation`,
          body,
          type: 'status'
        })
        try {
          await expect
            .poll(() => mailDisposition(readMailRow(userDataDir, sent.result.message.id)), {
              timeout: 60_000,
              message: `${live.agent} never received the mailbox pointer`
            })
            .toBe('pushed')
        } catch (error) {
          const agentStatus = await client.call('terminal.agentStatus', { terminal: handle })
          throw new Error(
            `${live.agent} delivery status: ${JSON.stringify(agentStatus.result)}\n${await readTerminalHistory(client, handle)}`,
            {
              cause: error
            }
          )
        }
        await expect
          .poll(
            async () =>
              countOccurrences(await readTerminalText(client, handle!), `RECEIVED_${marker}`),
            {
              timeout: 240_000,
              message: `${live.agent} did not consume the inbox message`
            }
          )
          .toBeGreaterThan(0)
      } finally {
        if (createdTerminalHandle) {
          await client
            .call('terminal.close', { terminal: createdTerminalHandle })
            .catch(() => undefined)
        }
        if (credentialDir) {
          rmSync(credentialDir, { recursive: true, force: true })
        }
        rmSync(subscriptionReceiptPath, { force: true })
        if (live.agent === 'claude') {
          removeClaudeTestTrust(active.result.worktree.path)
        }
      }
    })
  }
})
