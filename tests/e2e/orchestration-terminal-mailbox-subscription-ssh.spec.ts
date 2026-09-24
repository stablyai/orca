import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { RuntimeClient } from '../../src/cli/runtime-client'
import { powerShellCommand, powerShellLiteral } from '../../src/main/ssh/ssh-remote-powershell'
import type { SshConnectionState } from '../../src/shared/ssh-types'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import { test, expect } from './helpers/orca-app'
import {
  CODEX_IDLE_TITLE,
  CODEX_WORKING_TITLE,
  MAIL_PANE_AGENT_SOURCE,
  type AgentLedgerEntry
} from './helpers/orchestration-mail-pane-agent'
import { mailDisposition, readMailRow } from './helpers/orchestration-mail-store'
import { connectSshTestTarget } from './helpers/ssh-test-target-connection'
import { waitForSessionReady } from './helpers/store'

const RUN_REMOTE_SSH =
  process.env.ORCA_E2E_SSH_SUBSCRIPTION === '1' || process.env.ORCA_E2E_SSH_US === '1'
const SSH_HOST =
  process.env.ORCA_E2E_SSH_SUBSCRIPTION_HOST ?? process.env.ORCA_E2E_SSH_US_HOST ?? '100.73.93.61'
const SSH_USER =
  process.env.ORCA_E2E_SSH_SUBSCRIPTION_USER ?? process.env.ORCA_E2E_SSH_US_USER ?? 'ubuntu'
const SSH_PASSWORD = process.env.ORCA_E2E_SSH_SUBSCRIPTION_PASSWORD
const REMOTE_PLATFORM = process.env.ORCA_E2E_SSH_SUBSCRIPTION_PLATFORM ?? 'posix'
const WINDOWS_REMOTE = REMOTE_PLATFORM === 'win32'
const SSH_DESTINATION = `${SSH_USER}@${SSH_HOST}`
const POINTER_COMMAND = 'orca orchestration inbox'

test.use({
  orcaAppExtraEnv: SSH_PASSWORD ? {} : { ORCA_SSH_FORCE_SYSTEM_TRANSPORT: '1' },
  trace: SSH_PASSWORD ? 'off' : 'retain-on-failure'
})

function ssh(command: string, input?: string): string {
  const authArgs = SSH_PASSWORD
    ? ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no']
    : ['-o', 'BatchMode=yes']
  const sshArgs = [...authArgs, '-o', 'ConnectTimeout=15', SSH_DESTINATION, command]
  if (!SSH_PASSWORD) {
    return execFileSync('ssh', sshArgs, { encoding: 'utf8', input, timeout: 60_000 })
  }
  return withPasswordFile((passwordFile) =>
    execFileSync('sshpass', ['-f', passwordFile, 'ssh', ...sshArgs], {
      encoding: 'utf8',
      input,
      timeout: 60_000
    })
  )
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function windowsQuote(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function withPasswordFile<T>(run: (passwordFile: string) => T): T {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'orca-ssh-password-'))
  const passwordFile = path.join(tempDir, 'credential')
  writeFileSync(passwordFile, SSH_PASSWORD ?? '', { mode: 0o600 })
  try {
    return run(passwordFile)
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function writeWindowsFile(remotePath: string, value: string): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'orca-ssh-windows-file-'))
  const localPath = path.join(tempDir, 'payload')
  writeFileSync(localPath, value)
  try {
    const authArgs = SSH_PASSWORD
      ? ['-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no']
      : ['-o', 'BatchMode=yes']
    const destination = `${SSH_DESTINATION}:${remotePath.replaceAll('\\', '/')}`
    if (SSH_PASSWORD) {
      withPasswordFile((passwordFile) =>
        execFileSync(
          'sshpass',
          ['-f', passwordFile, 'scp', '-q', ...authArgs, localPath, destination],
          { timeout: 60_000 }
        )
      )
    } else {
      execFileSync('scp', ['-q', ...authArgs, localPath, destination], { timeout: 60_000 })
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

function seedRemoteRepo(remoteRepo: string): void {
  if (!WINDOWS_REMOTE) {
    ssh(
      `mkdir -p ${quote(remoteRepo)} && cd ${quote(remoteRepo)} && git init -q && git config user.email e2e@test.local && git config user.name 'Orca SSH E2E' && printf 'ssh mailbox e2e\n' > README.md && git add README.md && git commit -qm initial`
    )
    return
  }
  ssh(
    powerShellCommand(
      [
        `$repo = ${powerShellLiteral(remoteRepo)}`,
        'New-Item -ItemType Directory -Force -Path $repo | Out-Null',
        '& git -C $repo init -q',
        '& git -C $repo config user.email e2e@test.local',
        "& git -C $repo config user.name 'Orca SSH E2E'",
        "[IO.File]::WriteAllText((Join-Path $repo 'README.md'), 'ssh mailbox e2e' + [Environment]::NewLine)",
        '& git -C $repo add README.md',
        '& git -C $repo commit -qm initial',
        'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
      ].join('\n')
    )
  )
}

function removeRemoteRoot(remoteRoot: string): void {
  if (WINDOWS_REMOTE) {
    ssh(
      powerShellCommand(
        `Remove-Item -LiteralPath ${powerShellLiteral(remoteRoot)} -Recurse -Force -ErrorAction SilentlyContinue`
      )
    )
    return
  }
  ssh(`rm -rf ${quote(remoteRoot)}`)
}

type RemoteAgent = {
  launchCommand: string
  setTitle: (title: string) => void
  runCli: (requestId: string, args: string[]) => void
  readLedger: () => AgentLedgerEntry[]
  readStdin: () => string
  readCliResult: (requestId: string) => AgentLedgerEntry | undefined
}

function createRemoteAgent(remoteDir: string): RemoteAgent {
  const join = WINDOWS_REMOTE ? path.win32.join : path.posix.join
  const script = join(remoteDir, 'agent.cjs')
  const ledger = join(remoteDir, 'ledger.jsonl')
  const title = join(remoteDir, 'title')
  const cliControl = join(remoteDir, 'cli-control.json')
  if (WINDOWS_REMOTE) {
    ssh(
      powerShellCommand(
        `New-Item -ItemType Directory -Force -Path ${powerShellLiteral(remoteDir)} | Out-Null`
      )
    )
    writeWindowsFile(script, MAIL_PANE_AGENT_SOURCE)
    writeWindowsFile(ledger, '')
  } else {
    ssh(
      `mkdir -p ${quote(remoteDir)} && cat > ${quote(script)} && : > ${quote(ledger)}`,
      MAIL_PANE_AGENT_SOURCE
    )
  }

  const readLedger = (): AgentLedgerEntry[] => {
    const contents = ssh(
      WINDOWS_REMOTE
        ? `type ${windowsQuote(ledger)} 2>nul`
        : `cat ${quote(ledger)} 2>/dev/null || true`
    )
    return contents
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as AgentLedgerEntry]
        } catch {
          return []
        }
      })
  }
  const launchArg = WINDOWS_REMOTE ? windowsQuote : quote
  const cliCommand = 'orca'
  // PowerShell 5.1 drops empty native argv entries, so sentinels preserve positions.
  const encodedReaction = WINDOWS_REMOTE ? Buffer.from('null').toString('base64') : ''
  const cliEntry = WINDOWS_REMOTE ? '-' : ''
  return {
    launchCommand: `node ${launchArg(script)} ${launchArg(ledger)} ${launchArg(title)} ${launchArg(encodedReaction)} ${launchArg(cliControl)} ${launchArg(cliEntry)} ${launchArg(cliCommand)}`,
    setTitle: (value) =>
      WINDOWS_REMOTE ? writeWindowsFile(title, value) : ssh(`cat > ${quote(title)}`, value),
    runCli: (requestId, args) => {
      const value = JSON.stringify({ requestId, args })
      return WINDOWS_REMOTE
        ? writeWindowsFile(cliControl, value)
        : ssh(`cat > ${quote(cliControl)}`, value)
    },
    readLedger,
    readStdin: () =>
      readLedger()
        .filter((entry) => entry.event === 'stdin')
        .map((entry) => entry.data ?? '')
        .join(''),
    readCliResult: (requestId) =>
      readLedger().find((entry) => entry.event === 'cli' && entry.requestId === requestId)
  }
}

async function readUserDataDir(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ app }) => app.getPath('userData'))
}

async function reconnect(
  page: Page,
  targetId: string,
  credential?: string
): Promise<SshConnectionState> {
  const state = await page.evaluate(
    async ({ id, credential }) => {
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({
          requestId: request.requestId,
          value: credential ?? null
        })
      })
      try {
        return await window.api.ssh.connect({ targetId: id })
      } finally {
        credentialUnsub()
      }
    },
    { id: targetId, credential }
  )
  expect(state?.status).toBe('connected')
  if (!state) {
    throw new Error('SSH reconnect returned no connection state')
  }
  await page.evaluate(
    ({ id, state }) => {
      if (state) {
        window.__store?.getState().setSshConnectionState(id, state)
      }
    },
    { id: targetId, state }
  )
  return state
}

test.describe('SSH terminal mailbox subscription', () => {
  test.describe.configure({ timeout: 360_000 })
  test.skip(
    !RUN_REMOTE_SSH,
    'Set ORCA_E2E_SSH_SUBSCRIPTION=1 to run against a configured SSH host.'
  )

  test('preserves mail across disconnect and wakes the same remote PTY after reconnect', async ({
    orcaPage,
    electronApp
  }) => {
    const suffix = randomUUID()
    const remoteTemp = WINDOWS_REMOTE ? ssh('echo %TEMP%').trim() : '/tmp'
    const join = WINDOWS_REMOTE ? path.win32.join : path.posix.join
    const remoteRoot = join(remoteTemp, `orca-mailbox-subscription-${suffix}`)
    const remoteRepo = join(remoteRoot, 'repo')
    const remoteAgentDir = join(remoteRoot, 'agent')

    let agent!: RemoteAgent
    let targetId: string | null = null
    let createdWorktreeId: string | null = null
    try {
      seedRemoteRepo(remoteRepo)
      agent = createRemoteAgent(remoteAgentDir)
      await waitForSessionReady(orcaPage)
      const remote = await connectSshTestTarget(
        orcaPage,
        {
          label: `SSH mailbox ${suffix}`,
          host: SSH_HOST,
          port: 22,
          username: SSH_USER,
          relayGracePeriodSeconds: 0
        },
        {
          remotePath: remoteRepo,
          displayName: `SSH mailbox ${suffix}`,
          credential: SSH_PASSWORD
        }
      )
      targetId = remote.targetId
      const initialConnectionState = await orcaPage.evaluate(
        async (id) => window.api.ssh.getState({ targetId: id }),
        targetId
      )
      if (
        !initialConnectionState?.providerEpoch ||
        initialConnectionState.connectionGeneration === undefined
      ) {
        throw new Error(
          `Initial SSH connection returned incomplete authority: ${JSON.stringify(initialConnectionState)}`
        )
      }
      const userDataDir = await readUserDataDir(electronApp)
      const client = new RuntimeClient(userDataDir, 30_000, null, null)

      await orcaPage.evaluate(async (agentCommand) => {
        await window.__store?.getState().updateSettings({
          agentCmdOverrides: { codex: agentCommand },
          disabledTuiAgents: []
        })
      }, agent.launchCommand)
      const created = await client.call<{
        worktree: { id: string }
        agentTerminalHandle?: string
      }>('worktree.create', {
        repo: `id:${remote.repoId}`,
        name: `ssh-mail-${suffix}`,
        noParent: true,
        activate: false,
        setupDecision: 'skip',
        startupAgent: 'codex',
        startupPrompt: ''
      })
      createdWorktreeId = created.result.worktree.id
      const handle = created.result.agentTerminalHandle
      if (!handle) {
        throw new Error(
          `Remote Codex worktree did not publish a startup terminal handle: ${JSON.stringify(created.result)}`
        )
      }
      try {
        await expect
          .poll(() => agent.readLedger().find((entry) => entry.event === 'start'), {
            timeout: 60_000
          })
          .toMatchObject({ hasLaunchToken: true, terminalHandle: handle })
      } catch (error) {
        const terminal = await client
          .call('terminal.read', { terminal: handle, screen: true })
          .then((response) => response.result)
          .catch((readError) => ({ readError: String(readError) }))
        throw new Error(`Remote agent did not start: ${JSON.stringify(terminal)}`, {
          cause: error
        })
      }

      let ptyId: string | null = null
      await expect
        .poll(async () => {
          const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
          ptyId =
            listed.result.terminals.find((terminal) => terminal.handle === handle)?.ptyId ?? null
          return ptyId
        })
        .not.toBeNull()

      agent.setTitle(CODEX_WORKING_TITLE)
      await expect
        .poll(async () => {
          const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
          return listed.result.terminals.find((terminal) => terminal.handle === handle)?.title
        })
        .toBe(CODEX_WORKING_TITLE)
      agent.setTitle(CODEX_IDLE_TITLE)
      await expect
        .poll(async () => {
          const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
          return listed.result.terminals.find((terminal) => terminal.handle === handle)?.title
        })
        .toBe(CODEX_IDLE_TITLE)

      agent.runCli('subscribe', ['orchestration', 'subscribe', '--json'])
      try {
        await expect
          .poll(
            () =>
              agent
                .readLedger()
                .find((entry) => entry.event === 'cli-start' && entry.requestId === 'subscribe'),
            { timeout: 10_000 }
          )
          .toBeDefined()
      } catch (error) {
        throw new Error(
          `Remote CLI control was not observed: ${JSON.stringify(agent.readLedger())}`,
          {
            cause: error
          }
        )
      }
      try {
        await expect
          .poll(() => agent.readCliResult('subscribe'), { timeout: 30_000 })
          .toMatchObject({ status: 0 })
      } catch (error) {
        throw new Error(`Remote subscription CLI failed: ${JSON.stringify(agent.readLedger())}`, {
          cause: error
        })
      }
      expect(JSON.parse(agent.readCliResult('subscribe')?.stdout ?? '')).toMatchObject({
        ok: true,
        result: { subscribed: true, state: 'active' }
      })

      await orcaPage.evaluate(async (id) => window.api.ssh.disconnect({ targetId: id }), targetId)
      await expect
        .poll(
          () =>
            orcaPage.evaluate(
              async (id) => (await window.api.ssh.getState({ targetId: id }))?.status,
              targetId
            ),
          { timeout: 30_000 }
        )
        .not.toBe('connected')

      const pointersBefore = agent.readStdin().split(POINTER_COMMAND).length - 1
      const entersBefore = agent.readStdin().split('\r').length - 1
      const sent = await client.call<{ message: { id: string } }>('orchestration.send', {
        to: handle,
        from: 'ssh-e2e-sender',
        subject: 'queued during SSH disconnect',
        body: 'REMOTE_BODY_MUST_NOT_ENTER_PTY',
        type: 'status'
      })
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(mailDisposition(readMailRow(userDataDir, sent.result.message.id))).toBe('pending')
      expect(agent.readStdin().split(POINTER_COMMAND).length - 1).toBe(pointersBefore)

      const reconnectedState = await reconnect(orcaPage, targetId, SSH_PASSWORD)
      expect(reconnectedState.providerEpoch).toBeTruthy()
      expect(reconnectedState.providerEpoch).not.toBe(initialConnectionState.providerEpoch)
      expect(reconnectedState.connectionGeneration).toBeGreaterThan(
        initialConnectionState.connectionGeneration
      )
      agent.runCli('status-after-reconnect', ['orchestration', 'subscription', 'status', '--json'])
      await expect
        .poll(() => agent.readCliResult('status-after-reconnect'), { timeout: 30_000 })
        .toMatchObject({ status: 0 })
      expect(JSON.parse(agent.readCliResult('status-after-reconnect')?.stdout ?? '')).toMatchObject(
        {
          ok: true,
          result: { subscribed: true, state: 'active' }
        }
      )
      // A reconnected transport is not live idle evidence. The remote process must
      // publish a fresh agent transition before Orca can safely redrive queued mail.
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      expect(agent.readStdin().split(POINTER_COMMAND).length - 1).toBe(pointersBefore)

      agent.setTitle(CODEX_WORKING_TITLE)
      await expect
        .poll(async () => {
          const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
          return listed.result.terminals.find((terminal) => terminal.handle === handle)?.title
        })
        .toBe(CODEX_WORKING_TITLE)
      agent.setTitle(CODEX_IDLE_TITLE)
      await expect
        .poll(async () => {
          const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
          return listed.result.terminals.find((terminal) => terminal.handle === handle)?.title
        })
        .toBe(CODEX_IDLE_TITLE)
      await expect
        .poll(() => agent.readStdin().split(POINTER_COMMAND).length - 1, { timeout: 60_000 })
        .toBe(pointersBefore + 1)
      expect(agent.readStdin()).not.toContain('REMOTE_BODY_MUST_NOT_ENTER_PTY')
      await expect
        .poll(() => agent.readStdin().split('\r').length - 1, { timeout: 10_000 })
        .toBe(entersBefore + 1)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      expect(agent.readStdin().split(POINTER_COMMAND).length - 1).toBe(pointersBefore + 1)
      expect(agent.readStdin().split('\r').length - 1).toBe(entersBefore + 1)
      await expect
        .poll(() => mailDisposition(readMailRow(userDataDir, sent.result.message.id)), {
          timeout: 30_000
        })
        .toBe('pushed')
      expect(readMailRow(userDataDir, sent.result.message.id)).toMatchObject({ read: 0 })

      const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
      expect(listed.result.terminals.find((terminal) => terminal.handle === handle)).toMatchObject({
        ptyId
      })
    } finally {
      if (createdWorktreeId) {
        const userDataDir = await readUserDataDir(electronApp).catch(() => null)
        if (userDataDir) {
          const client = new RuntimeClient(userDataDir, 30_000, null, null)
          await client
            .call('worktree.rm', {
              worktree: `id:${createdWorktreeId}`,
              force: true,
              allowUnverifiedPtyStop: true,
              runHooks: false
            })
            .catch(() => undefined)
        }
      }
      if (targetId) {
        await orcaPage
          .evaluate(async (id) => {
            await window.api.ssh.terminateSessions({ targetId: id }).catch(() => undefined)
            await window.api.ssh.disconnect({ targetId: id }).catch(() => undefined)
            await window.api.ssh.removeTarget({ id }).catch(() => undefined)
          }, targetId)
          .catch(() => undefined)
      }
      try {
        removeRemoteRoot(remoteRoot)
      } catch {
        // Windows can retain a just-exited ConPTY file handle briefly.
      }
    }
  })
})
