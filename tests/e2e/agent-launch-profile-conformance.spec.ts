import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RuntimeTerminalRead } from '../../src/shared/runtime-terminal-contracts'
import { expect, test } from './helpers/orca-app'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'

// Host-contract conformance for agent launch profiles. Everything is asserted over the
// runtime RPC, so the same expectations hold for any client (desktop, paired web, mobile, CLI)
// that reaches this host: a fake agent echoes the env the profile is supposed to produce.

type LaunchProfileEcho = {
  codexHome: string | null
  claudeConfigDir: string | null
  profile: string | null
  codexMarker: string | null
  claudeMarker: string | null
}

const ECHO_PREFIX = 'LAUNCH_PROFILE_ENV:'

function operationId(): string {
  return `${Date.now()}-${randomBytes(16).toString('hex')}`
}

function fixtureCommand(fixturePath: string): string {
  return process.platform === 'win32'
    ? `& "${process.execPath.replaceAll('"', '`"')}" "${fixturePath.replaceAll('"', '`"')}"`
    : `'${process.execPath.replaceAll("'", `'\\''`)}' '${fixturePath.replaceAll("'", `'\\''`)}'`
}

async function readEcho(
  host: HeadlessPairedRuntimeHost,
  handle: string
): Promise<LaunchProfileEcho> {
  let echo: LaunchProfileEcho | null = null
  await expect
    .poll(
      async () => {
        const read = await host.client.call<{ terminal: RuntimeTerminalRead }>('terminal.read', {
          terminal: handle,
          limit: 200
        })
        const line = read.result.terminal.tail.find((entry) => entry.includes(ECHO_PREFIX))
        if (!line) {
          return null
        }
        echo = JSON.parse(
          line.slice(line.indexOf(ECHO_PREFIX) + ECHO_PREFIX.length)
        ) as LaunchProfileEcho
        return echo
      },
      { timeout: 30_000, message: `terminal ${handle} never echoed its launch env` }
    )
    .not.toBeNull()
  return echo!
}

test('launch profiles relocate credential homes on the execution host', async ({
  testRepoPath
}) => {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'orca-launch-profile-'))
  const fixturePath = path.join(fixtureRoot, 'launch-profile-echo.mjs')
  writeFileSync(
    fixturePath,
    [
      'const env = process.env',
      `process.stdout.write(${JSON.stringify(ECHO_PREFIX)} + JSON.stringify({`,
      '  codexHome: env.CODEX_HOME ?? null,',
      '  claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? null,',
      '  profile: env.ORCA_AGENT_LAUNCH_PROFILE ?? null,',
      '  codexMarker: env.ORCA_CODEX_HOME_PROFILE ?? null,',
      '  claudeMarker: env.ORCA_CLAUDE_CONFIG_DIR_PROFILE ?? null',
      "}) + '\\r\\n')",
      'setInterval(() => {}, 1000)',
      ''
    ].join('\n')
  )
  const command = fixtureCommand(fixturePath)
  const host = await launchHeadlessPairedRuntimeHost({
    settings: {
      agentCmdOverrides: { codex: command, claude: command },
      agentLaunchProfiles: [
        { id: 'codex-echo-route', agent: 'codex', label: 'Echo route', env: { ECHO_ROUTE: '1' } }
      ]
    }
  })
  const handles: string[] = []
  try {
    await host.client.call('repo.add', { path: testRepoPath, kind: 'git' })
    const ps = await host.client.call<{ worktrees: { worktreeId: string }[] }>('worktree.ps', {
      limit: 50
    })
    const worktreeId = ps.result.worktrees[0]?.worktreeId
    expect(worktreeId).toBeTruthy()
    const worktree = `id:${worktreeId}`

    const codex = await host.client.call<{ terminal: { handle: string } }>(
      'terminal.createAgentSession',
      {
        clientOperationId: operationId(),
        worktree,
        agent: 'codex',
        launchProfileId: 'codex-secondary-home',
        presentation: 'background'
      }
    )
    handles.push(codex.result.terminal.handle)
    const codexEcho = await readEcho(host, codex.result.terminal.handle)
    // Why: the headless host runs with an isolated HOME under its userData dir, so assert the
    // shape (its own home + .codex-2) rather than this machine's real home directory.
    expect(codexEcho.codexHome).toBe(path.join(host.userDataDir, 'home', '.codex-2'))
    expect(codexEcho.profile).toBe('codex-secondary-home')
    // Why: the marker is consumed by the execution host; leaking it would let a nested launch re-resolve it.
    expect(codexEcho.codexMarker).toBeNull()

    // Why: the legacy create path (mobile, older web clients) carries the profile as a field too.
    const claude = await host.client.call<{ tab: { id: string }; terminal?: { handle: string } }>(
      'session.tabs.createTerminal',
      { worktree, agent: 'claude', launchProfileId: 'claude-secondary-home', activate: false }
    )
    const claudeHandle =
      claude.result.terminal?.handle ??
      (
        await host.client.call<{ terminals: { handle: string; tabId?: string }[] }>(
          'terminal.list',
          { worktree }
        )
      ).result.terminals.find((entry) => !handles.includes(entry.handle))?.handle
    expect(claudeHandle).toBeTruthy()
    handles.push(claudeHandle!)
    const claudeEcho = await readEcho(host, claudeHandle!)
    expect(claudeEcho.claudeConfigDir).toBe(path.join(host.userDataDir, 'home', '.claude-2'))
    expect(claudeEcho.profile).toBe('claude-secondary-home')
    expect(claudeEcho.claudeMarker).toBeNull()

    const plain = await host.client.call<{ terminal: { handle: string } }>(
      'terminal.createAgentSession',
      { clientOperationId: operationId(), worktree, agent: 'codex', presentation: 'background' }
    )
    handles.push(plain.result.terminal.handle)
    const plainEcho = await readEcho(host, plain.result.terminal.handle)
    expect(plainEcho.profile).toBeNull()
    expect(plainEcho.codexHome).not.toBe(codexEcho.codexHome)

    await expect(
      host.client.call('terminal.createAgentSession', {
        clientOperationId: operationId(),
        worktree,
        agent: 'codex',
        launchProfileId: 'no-such-profile',
        presentation: 'background'
      })
    ).rejects.toThrow(/agent_session_launch_profile_unknown/)
    await expect(
      host.client.call('terminal.createAgentSession', {
        clientOperationId: operationId(),
        worktree,
        agent: 'claude',
        launchProfileId: 'codex-echo-route',
        presentation: 'background'
      })
    ).rejects.toThrow(/agent_session_launch_profile_agent_mismatch/)
  } finally {
    for (const handle of handles) {
      await host.client.call('terminal.close', { terminal: handle }).catch(() => undefined)
    }
    await host.dispose()
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
