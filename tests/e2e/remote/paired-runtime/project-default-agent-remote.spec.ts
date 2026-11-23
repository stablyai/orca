import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { runProcess } from '@orca/process-host'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { cleanupE2EDaemons } from '../../desktop/electron-fixtures/electron-process-shutdown'
import { cliServeProfile, startCliServe } from './client-hosts/orca-serve-cli-host'
import { launchPairedElectronClient } from './client-hosts/paired-electron-client'
import {
  buildFakeAgentCommandOverride,
  FAKE_AGENT_WINDOWS_SHELL
} from '../../agents/session-fixtures/fake-agent-command-override'

const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-project-default-agent-'))
const fakeCodex = path.join(fakeDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
const spawnLedger = path.join(fakeDir, 'spawn.jsonl')
const fakeSource = `
const { appendFileSync } = require('node:fs')
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.0.0\\n')
  process.exit(0)
}
if (process.argv.includes('app-server')) process.exit(2)
if (process.argv.includes('--help')) {
  process.stdout.write('Usage: codex [OPTIONS] [PROMPT]\\n')
  process.exit(0)
}
appendFileSync(process.env.ORCA_E2E_PROJECT_AGENT_LEDGER, JSON.stringify({
  pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2)
}) + '\\n')
process.stdout.write('\\u001b]0;Codex Ready\\u0007OpenAI Codex\\nmodel: e2e\\ndirectory: e2e\\n')
process.stdin.resume()
setInterval(() => {}, 60_000)
`

if (process.platform === 'win32') {
  writeFileSync(path.join(fakeDir, 'fake-codex.js'), fakeSource)
  writeFileSync(fakeCodex, '@echo off\r\nnode "%~dp0\\fake-codex.js" %*\r\n')
} else {
  writeFileSync(fakeCodex, `#!/usr/bin/env node\n${fakeSource}`)
  chmodSync(fakeCodex, 0o755)
}

test.afterAll(() => rmSync(fakeDir, { recursive: true, force: true }))

const createdSchema = z.object({
  launch: z.object({
    resolvedAgent: z.object({
      agent: z.literal('codex'),
      source: z.literal('project'),
      projectId: z.string()
    }),
    outcome: z.object({ kind: z.literal('terminal'), handle: z.string() }),
    worktreeId: z.string()
  })
})
const launchedSchema = z.object({
  resolvedAgent: z.object({
    agent: z.literal('codex'),
    source: z.literal('project'),
    projectId: z.string()
  }),
  outcome: z.object({ kind: z.literal('terminal'), handle: z.string() }),
  worktreeId: z.string()
})

const cliEnvelope = z.object({
  ok: z.boolean().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string().optional() }).optional()
})

async function runCompiledOrcaCli(userDataDir: string, args: string[]) {
  const result = await runProcess({
    program: process.execPath,
    args: [path.join(process.cwd(), 'out', 'cli', 'index.js'), ...args],
    env: {
      ...process.env,
      ORCA_USER_DATA_PATH: userDataDir,
      ORCA_DEV_CLI_INVOCATION: '1',
      ORCA_BACKGROUND_LAUNCH: '1'
    },
    timeoutMs: 120_000,
    maxOutputBytes: 4 * 1024 * 1024
  })
  const json = cliEnvelope.parse(JSON.parse(result.stdout))
  return { ...result, json }
}

function spawnedAgents(): { pid: number; cwd: string; args: string[] }[] {
  if (!existsSync(spawnLedger)) {
    return []
  }
  return readFileSync(spawnLedger, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) =>
      z
        .object({ pid: z.number(), cwd: z.string(), args: z.array(z.string()) })
        .parse(JSON.parse(line))
    )
}

test('a paired client starts the target project default on its server and refuses blank before creation', async ({
  testRepoPath
}, testInfo) => {
  // Pairing two isolated Electron runtimes and launching two agents share this budget.
  test.setTimeout(180_000)
  const profile = cliServeProfile(fakeDir)
  const host = await startCliServe(profile, {
    PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}`,
    ORCA_E2E_PROJECT_AGENT_LEDGER: spawnLedger,
    ORCA_SERVE_RUNTIME: 'electron',
    ORCA_BACKGROUND_LAUNCH: '1'
  })
  const hostClient = new RuntimeClient(profile.userDataDir, 30_000, null, null)
  let paired: Awaited<ReturnType<typeof launchPairedElectronClient>> | undefined
  try {
    const client = await launchPairedElectronClient(
      { pairingUrl: z.object({ url: z.string() }).parse(host.readiness.pairing).url },
      testInfo,
      'Project default agent client'
    )
    paired = client
    await client.page.setViewportSize({ width: 1440, height: 1080 })
    const added = await hostClient.call<{ repo: { id: string; path: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    const repo = added.result.repo
    const listed = await hostClient.call<{
      projects: { id: string; sourceRepoIds: string[] }[]
    }>('project.list')
    const project = listed.result.projects.find((entry) => entry.sourceRepoIds.includes(repo.id))
    if (!project) {
      throw new Error('The server did not register the target project')
    }
    await hostClient.call('settings.update', {
      defaultTuiAgent: 'claude',
      ...(process.platform === 'win32' ? { terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL } : {})
    })
    await hostClient.call('settings.mutateAgentLaunch', {
      type: 'command',
      agent: 'codex',
      value: buildFakeAgentCommandOverride(fakeCodex)
    })
    await hostClient.call('project.update', {
      projectId: project.id,
      updates: { defaultTuiAgent: 'codex' }
    })

    await hostClient.call('settings.update', { defaultTuiAgent: 'codex' })
    await hostClient.call('project.update', {
      projectId: project.id,
      updates: { defaultTuiAgent: null }
    })
    await client.page.evaluate(
      async ({ repoId, projectId, hostId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('The paired client store is unavailable')
        }
        await store.getState().fetchReposForAllHosts()
        store.setState((state) => ({
          settings: state.settings ? { ...state.settings, defaultTuiAgent: 'claude' } : null
        }))
        store.getState().openModal('new-workspace-composer', {
          prefilledName: 'inherited-default-preview',
          initialRepoId: repoId,
          initialWorkspaceTarget: { projectId, hostId }
        })
      },
      { repoId: repo.id, projectId: project.id, hostId: `runtime:${client.environmentId}` as const }
    )
    const composer = client.page.getByRole('dialog', { name: 'Create worktree', exact: true })
    await expect(composer).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Select agent', exact: true })).toContainText(
      'Codex'
    )
    await expect(
      composer.getByRole('button', { name: 'Create worktree', exact: true })
    ).toBeEnabled()
    await composer.screenshot({ path: testInfo.outputPath('inherited-server-default.png') })
    await client.page.keyboard.press('Escape')
    await expect(composer).not.toBeVisible()
    await hostClient.call('settings.update', { defaultTuiAgent: 'claude' })
    await hostClient.call('project.update', {
      projectId: project.id,
      updates: { defaultTuiAgent: 'codex' }
    })

    const cliArgs = (name: string) => [
      'worktree',
      'create',
      '--environment',
      client.environmentId,
      '--project',
      project.id,
      '--name',
      name,
      '--no-parent',
      '--agent',
      'default',
      '--surface',
      'terminal',
      '--json'
    ]
    const launched = await runCompiledOrcaCli(client.userDataDir, cliArgs('project-default-remote'))
    expect(launched.code, launched.stdout + launched.stderr).toBe(0)
    expect(launched.json?.ok).toBe(true)
    const created = createdSchema.parse(launched.json?.result)
    expect(created.launch.resolvedAgent.projectId).toBe(project.id)
    const workspace = await hostClient.call<{ worktree: { path: string } }>('worktree.show', {
      worktree: `id:${created.launch.worktreeId}`
    })
    const terminal = await hostClient.call<{ terminal: { worktreeId: string } }>('terminal.show', {
      terminal: created.launch.outcome.handle
    })
    expect(terminal.result.terminal.worktreeId).toBe(created.launch.worktreeId)
    await expect
      .poll(() => spawnedAgents().some((agent) => agent.cwd === workspace.result.worktree.path))
      .toBe(true)
    await expect(
      client.page.getByText('project-default-remote', { exact: true }).first()
    ).toBeVisible({
      timeout: 30_000
    })

    const existing = await hostClient.call<{ worktree: { id: string; path: string } }>(
      'worktree.create',
      { repo: `id:${repo.id}`, name: 'project-default-existing' }
    )
    const launchedExisting = await runCompiledOrcaCli(client.userDataDir, [
      'agent',
      'launch',
      '--environment',
      client.environmentId,
      '--worktree',
      `id:${existing.result.worktree.id}`,
      '--agent',
      'default',
      '--surface',
      'terminal',
      '--json'
    ])
    expect(launchedExisting.code, launchedExisting.stdout + launchedExisting.stderr).toBe(0)
    expect(launchedExisting.json?.ok).toBe(true)
    const launchedAgent = launchedSchema.parse(launchedExisting.json?.result)
    expect(launchedAgent.resolvedAgent.projectId).toBe(project.id)
    expect(launchedAgent.worktreeId).toBe(existing.result.worktree.id)
    const existingTerminal = await hostClient.call<{ terminal: { worktreeId: string } }>(
      'terminal.show',
      { terminal: launchedAgent.outcome.handle }
    )
    expect(existingTerminal.result.terminal.worktreeId).toBe(existing.result.worktree.id)
    await expect
      .poll(() => spawnedAgents().some((agent) => agent.cwd === existing.result.worktree.path))
      .toBe(true)

    await hostClient.call('project.update', {
      projectId: project.id,
      updates: { defaultTuiAgent: 'blank' }
    })
    const before = await hostClient.call<{ worktrees: { id: string }[] }>('worktree.list', {
      repo: `id:${repo.id}`
    })
    const refused = await runCompiledOrcaCli(client.userDataDir, cliArgs('project-default-blank'))
    expect(refused.code).not.toBe(0)
    expect(refused.json?.error?.message).toContain('Blank Terminal')
    const after = await hostClient.call<{ worktrees: { id: string }[] }>('worktree.list', {
      repo: `id:${repo.id}`
    })
    expect(after.result.worktrees.map((entry) => entry.id)).toEqual(
      before.result.worktrees.map((entry) => entry.id)
    )
  } finally {
    try {
      await paired?.dispose()
    } finally {
      try {
        await host.stop()
      } finally {
        await cleanupE2EDaemons(profile.userDataDir)
      }
    }
  }
})
