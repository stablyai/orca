/**
 * The window builds a run's spawn from what it holds (its raw prompt, its extras); its host builds it
 * from what the window sent over `agent.launch` (the argv prompt, already trimmed, and extras only
 * when set). Both must land on the same spawn.
 */

import { describe, expect, it } from 'vitest'
import {
  backgroundRunPaneEnv,
  buildBackgroundRunPtySpawn,
  buildBackgroundRunStartup
} from './background-run-launch'
import type { TuiAgent } from './tui-agent'

const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const SETTINGS = { agentDefaultArgs: { claude: '--model sonnet' } }

type Run = {
  agent: TuiAgent
  prompt?: string
  extraAgentArgs?: string
  platform?: NodeJS.Platform
  cwd?: string
  worktreeId?: string
  sshConnectionId?: string | null
  title?: string
}

function spawnFor(run: Run, startup: ReturnType<typeof buildBackgroundRunStartup>) {
  if (!startup) {
    throw new Error('no plan')
  }
  const worktreeId = run.worktreeId ?? 'wt-1'
  return buildBackgroundRunPtySpawn({
    agent: run.agent,
    plan: startup.plan,
    cwd: run.cwd ?? '/repo/wt-1',
    worktreeId,
    sshConnectionId: run.sshConnectionId ?? null,
    env: backgroundRunPaneEnv({
      env: startup.plan.env,
      paneKey: `${TAB_ID}:${LEAF_ID}`,
      tabId: TAB_ID,
      worktreeId,
      launchToken: 'token-1'
    }),
    launchToken: 'token-1',
    tabId: TAB_ID,
    leafId: LEAF_ID,
    ...(run.title ? { title: run.title } : {})
  })
}

/** The window's own spawn: raw prompt, extras passed as it holds them. */
function windowSpawn(run: Run) {
  const startup = buildBackgroundRunStartup({
    agent: run.agent,
    settings: SETTINGS,
    platform: run.platform ?? 'darwin',
    isRemote: Boolean(run.sshConnectionId),
    extraAgentArgs: run.extraAgentArgs,
    prompt: run.prompt
  })
  return { startup, spawn: spawnFor(run, startup) }
}

/** The host's spawn, from only what the window sends it. */
function hostSpawn(run: Run) {
  const sent = windowSpawn(run).startup?.commandPrompt
  const startup = buildBackgroundRunStartup({
    agent: run.agent,
    settings: SETTINGS,
    platform: run.platform ?? 'darwin',
    isRemote: false,
    ...(run.extraAgentArgs ? { extraAgentArgs: run.extraAgentArgs } : {}),
    ...(sent ? { prompt: sent } : {})
  })
  return spawnFor({ ...run, sshConnectionId: null }, startup)
}

describe("a desktop automation run's spawn", () => {
  it('puts an argv agent’s trimmed prompt and extras on the command', () => {
    const run = {
      agent: 'claude' as const,
      prompt: '  Review the diff\n',
      extraAgentArgs: '--effort high',
      title: 'Nightly'
    }
    const { startup, spawn } = windowSpawn(run)

    expect(startup).toMatchObject({ commandPrompt: 'Review the diff', pastePromptAfterStart: null })
    expect(spawn.command).toContain("'--effort' 'high'")
    expect(spawn.command).toContain('Review the diff')
    expect(spawn.placement).toEqual({ kind: 'new-tab', row: { customTitle: 'Nightly' } })
    expect(spawn.telemetry).toEqual({
      agent_kind: 'claude-code',
      launch_source: 'unknown',
      request_kind: 'new'
    })
    expect(Object.keys(spawn.env).slice(-4)).toEqual([
      'ORCA_PANE_KEY',
      'ORCA_TAB_ID',
      'ORCA_WORKTREE_ID',
      'ORCA_AGENT_LAUNCH_TOKEN'
    ])
    expect(hostSpawn(run)).toEqual(spawn)
  })

  it('starts a post-start agent bare and leaves its prompt to paste', () => {
    const run = { agent: 'aider' as const, prompt: ' fix the bug ' }
    const { startup, spawn } = windowSpawn(run)

    expect(startup).not.toHaveProperty('commandPrompt')
    expect(startup?.pastePromptAfterStart).toBe('fix the bug')
    expect(spawn.command).not.toContain('fix the bug')
    expect(hostSpawn(run)).toEqual(spawn)
  })

  it('treats a blank prompt as none', () => {
    const run = { agent: 'claude' as const, prompt: '   ' }

    expect(windowSpawn(run).startup).toMatchObject({ pastePromptAfterStart: null })
    expect(windowSpawn(run).startup).not.toHaveProperty('commandPrompt')
    expect(hostSpawn(run)).toEqual(windowSpawn(run).spawn)
  })

  it('carries no title row and an unknown source when the run has neither', () => {
    const { spawn } = windowSpawn({ agent: 'claude' })

    expect(spawn.placement).toEqual({ kind: 'new-tab' })
    expect(spawn.telemetry.launch_source).toBe('unknown')
  })

  it('spawns a folder workspace at its folder', () => {
    const run = {
      agent: 'codex' as const,
      prompt: 'go',
      cwd: '/Users/me/notes',
      worktreeId: 'folder:notes-1'
    }
    const { spawn } = windowSpawn(run)

    expect(spawn).toMatchObject({ cwd: '/Users/me/notes', worktreeId: 'folder:notes-1' })
    expect(spawn.env.ORCA_WORKTREE_ID).toBe('folder:notes-1')
    expect(hostSpawn(run)).toEqual(spawn)
  })

  it('opens a local WSL path in the WSL shell', () => {
    const run = {
      agent: 'claude' as const,
      platform: 'win32' as const,
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\wt-1'
    }
    const { spawn } = windowSpawn(run)

    expect(spawn.shellOverride).toBe('wsl.exe')
    expect(hostSpawn(run)).toEqual(spawn)
  })

  it('lets the SSH relay type the command, with no WSL shell', () => {
    const { spawn } = windowSpawn({
      agent: 'claude',
      prompt: 'go',
      platform: 'linux',
      sshConnectionId: 'ssh-1',
      cwd: '\\\\wsl.localhost\\Ubuntu\\home\\me\\wt-1'
    })

    expect(spawn).toMatchObject({
      connectionId: 'ssh-1',
      commandDelivery: 'provider',
      startupCommandDelivery: 'shell-ready'
    })
    expect(spawn).not.toHaveProperty('shellOverride')
  })

  it('throws on invalid extras before anything is built', () => {
    expect(() => windowSpawn({ agent: 'claude', extraAgentArgs: '"unclosed' })).toThrow()
  })
})
