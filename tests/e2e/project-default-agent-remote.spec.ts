import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { test, expect } from './helpers/orca-app'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import { launchPairedElectronClient } from './helpers/paired-electron-client'
import { runCompiledOrcaCli } from './helpers/compiled-orca-cli'
import { buildFakeAgentCommandOverride } from './helpers/fake-agent-command-override'
import { FAKE_CODEX_LAUNCH_PROBES_SOURCE } from './helpers/fake-codex-launch-probes'

const fakeDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-project-default-agent-'))
const fakeCodex = path.join(fakeDir, process.platform === 'win32' ? 'codex.cmd' : 'codex')
const spawnLedger = path.join(fakeDir, 'spawn.jsonl')
const fakeSource = `
const { appendFileSync } = require('node:fs')
${FAKE_CODEX_LAUNCH_PROBES_SOURCE}
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
  // The budget includes pairing two isolated runtimes and launching two terminal agents.
  test.setTimeout(180_000)
  const host = await launchHeadlessPairedRuntimeHost({
    extraEnv: {
      PATH: `${fakeDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ORCA_E2E_PROJECT_AGENT_LEDGER: spawnLedger
    }
  })
  let paired: Awaited<ReturnType<typeof launchPairedElectronClient>> | undefined
  try {
    const client = await launchPairedElectronClient(
      host.offer,
      testInfo,
      'Project default agent client'
    )
    paired = client
    const added = await host.client.call<{ repo: { id: string; path: string } }>('repo.add', {
      path: testRepoPath,
      kind: 'git'
    })
    const repo = added.result.repo
    const listed = await host.client.call<{
      projects: { id: string; sourceRepoIds: string[] }[]
    }>('project.list')
    const project = listed.result.projects.find((entry) => entry.sourceRepoIds.includes(repo.id))
    if (!project) {
      throw new Error('The server did not register the target project')
    }
    await host.client.call('settings.update', { defaultTuiAgent: 'claude' })
    await host.client.call('settings.mutateAgentLaunch', {
      type: 'command',
      agent: 'codex',
      value: buildFakeAgentCommandOverride(fakeCodex)
    })
    await host.client.call('project.update', {
      projectId: project.id,
      updates: { defaultTuiAgent: 'codex' }
    })

    await host.client.call('settings.update', { defaultTuiAgent: 'codex' })
    await host.client.call('project.update', {
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
    await expect(
      composer
        .locator('[data-contextual-tour-target="workspace-creation-agent"]')
        .getByRole('combobox')
    ).toContainText('Codex')
    await expect(
      composer.getByRole('button', { name: 'Create worktree', exact: true })
    ).toBeEnabled()
    await composer.screenshot({ path: testInfo.outputPath('inherited-server-default.png') })
    await client.page.keyboard.press('Escape')
    await expect(composer).not.toBeVisible()
    await host.client.call('settings.update', { defaultTuiAgent: 'claude' })
    await host.client.call('project.update', {
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
    const workspace = await host.client.call<{ worktree: { path: string } }>('worktree.show', {
      worktree: `id:${created.launch.worktreeId}`
    })
    const terminal = await host.client.call<{ terminal: { worktreeId: string } }>('terminal.show', {
      terminal: created.launch.outcome.handle
    })
    expect(terminal.result.terminal.worktreeId).toBe(created.launch.worktreeId)
    await expect.poll(() => spawnedAgents()).toHaveLength(1)
    expect(spawnedAgents()[0]?.cwd).toBe(workspace.result.worktree.path)
    await expect(
      client.page.getByText('project-default-remote', { exact: true }).first()
    ).toBeVisible({
      timeout: 30_000
    })

    const existing = await host.client.call<{ worktree: { id: string; path: string } }>(
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
    const existingTerminal = await host.client.call<{ terminal: { worktreeId: string } }>(
      'terminal.show',
      { terminal: launchedAgent.outcome.handle }
    )
    expect(existingTerminal.result.terminal.worktreeId).toBe(existing.result.worktree.id)
    await expect.poll(() => spawnedAgents()).toHaveLength(2)
    expect(spawnedAgents()[1]?.cwd).toBe(existing.result.worktree.path)

    await host.client.call('project.update', {
      projectId: project.id,
      updates: { defaultTuiAgent: 'blank' }
    })
    const before = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
      repo: `id:${repo.id}`
    })
    const refused = await runCompiledOrcaCli(client.userDataDir, cliArgs('project-default-blank'))
    expect(refused.code).not.toBe(0)
    expect(refused.json?.error?.message).toContain('Blank Terminal')
    const after = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
      repo: `id:${repo.id}`
    })
    expect(after.result.worktrees.map((entry) => entry.id)).toEqual(
      before.result.worktrees.map((entry) => entry.id)
    )
    expect(spawnedAgents()).toHaveLength(2)
  } finally {
    try {
      await paired?.dispose()
    } finally {
      await host.dispose()
    }
  }
})
