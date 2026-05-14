import os from 'os'
import path from 'path'

import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

type LocalhostSshTarget = {
  label: string
  host: string
  port: number
  username: string
  configHost?: string
  identityFile?: string
}

const RUN_LOCALHOST_SSH = process.env.ORCA_E2E_SSH_LOCALHOST === '1'
const RUN_REMOTE_HOOKS =
  process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS !== undefined &&
  process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS.trim() !== '' &&
  process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS.trim() !== '0'

function parsePort(value: string | undefined): number {
  const parsed = Number(value ?? '22')
  if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) {
    return parsed
  }
  throw new Error(`Invalid ORCA_E2E_SSH_PORT: ${value}`)
}

function currentUsername(): string {
  return (
    process.env.ORCA_E2E_SSH_USER ??
    process.env.USER ??
    process.env.USERNAME ??
    os.userInfo().username
  )
}

function readLocalhostSshTarget(): LocalhostSshTarget {
  const configHost = process.env.ORCA_E2E_SSH_CONFIG_HOST?.trim()
  const host = process.env.ORCA_E2E_SSH_HOST?.trim() ?? (configHost ? '' : '127.0.0.1')
  const identityFile = process.env.ORCA_E2E_SSH_IDENTITY_FILE?.trim()

  return {
    label: `Localhost SSH E2E ${Date.now()}`,
    host,
    port: parsePort(process.env.ORCA_E2E_SSH_PORT),
    username: currentUsername(),
    ...(configHost ? { configHost } : {}),
    ...(identityFile ? { identityFile } : {})
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function marker(name: string): string {
  return `__ORCA_${name}_${Date.now()}__`
}

function emitMarkerCommand(value: string): string {
  const midpoint = Math.floor(value.length / 2)
  return `printf '%s%s\\n' ${shellQuote(value.slice(0, midpoint))} ${shellQuote(
    value.slice(midpoint)
  )}`
}

test.describe('Localhost SSH', () => {
  test.skip(
    !RUN_LOCALHOST_SSH,
    'Set ORCA_E2E_SSH_LOCALHOST=1 to run this local-machine-only SSH E2E test.'
  )
  test.skip(
    !RUN_REMOTE_HOOKS,
    'Set ORCA_FEATURE_REMOTE_AGENT_HOOKS=1 so remote PTYs keep pane identity and forward hook events.'
  )
  test.skip(process.platform === 'win32', 'Localhost SSH hook E2E uses POSIX hook scripts.')

  test('routes a terminal and agent-hook status over localhost SSH', async ({
    orcaPage,
    testRepoPath
  }) => {
    test.slow()
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)

    const target = readLocalhostSshTarget()
    const remote = await orcaPage.evaluate(
      async ({ remotePath, target }) => {
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }

        const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
          void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
        })

        try {
          const createdTarget = await window.api.ssh.addTarget({
            target: {
              ...target,
              // Why: local-only E2E should not leave a long-lived relay process
              // behind if the Electron app is killed between cleanup hooks.
              relayGracePeriodSeconds: 1
            }
          })

          let state
          try {
            state = await window.api.ssh.connect({ targetId: createdTarget.id })
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            throw new Error(
              `Failed to connect to localhost SSH target ${target.username}@${target.host || target.configHost}:${target.port}. ` +
                `Ensure sshd is running and key/agent auth is non-interactive. ${message}`
            )
          }

          if (!state || state.status !== 'connected') {
            throw new Error(`SSH target did not reach connected state: ${JSON.stringify(state)}`)
          }

          store.getState().setSshConnectionState(createdTarget.id, state)
          const labels = new Map(store.getState().sshTargetLabels)
          labels.set(createdTarget.id, createdTarget.label)
          store.getState().setSshTargetLabels(labels)

          const result = await window.api.repos.addRemote({
            connectionId: createdTarget.id,
            remotePath,
            displayName: 'Localhost SSH E2E'
          })
          if ('error' in result) {
            throw new Error(result.error)
          }

          await store.getState().fetchRepos()
          await store.getState().fetchWorktrees(result.repo.id)

          const worktrees = store.getState().worktreesByRepo[result.repo.id] ?? []
          const worktree =
            worktrees.find((candidate) => candidate.path === result.repo.path) ?? worktrees[0]
          if (!worktree) {
            throw new Error(`No remote worktree found for ${result.repo.path}`)
          }

          store.getState().setActiveWorktree(worktree.id)
          if ((store.getState().tabsByWorktree[worktree.id] ?? []).length === 0) {
            store.getState().createTab(worktree.id)
          }
          store.getState().setActiveTabType('terminal')

          return {
            targetId: createdTarget.id,
            repoId: result.repo.id,
            worktreeId: worktree.id
          }
        } finally {
          credentialUnsub()
        }
      },
      { remotePath: testRepoPath, target }
    )

    await expect(remote.targetId).toBeTruthy()
    await ensureTerminalVisible(orcaPage, 30_000)
    await waitForActiveTerminalManager(orcaPage, 45_000)
    const ptyId = await waitForActivePanePtyId(orcaPage, 45_000)
    const paneKey = await orcaPage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const state = store.getState()
      const worktreeId = state.activeWorktreeId
      if (!worktreeId) {
        throw new Error('No active worktree')
      }
      const tabs = state.tabsByWorktree[worktreeId] ?? []
      const tabId =
        state.activeTabType === 'terminal'
          ? state.activeTabId
          : (state.activeTabIdByWorktree?.[worktreeId] ?? tabs[0]?.id)
      if (!tabId) {
        throw new Error('No active terminal tab')
      }
      const manager = window.__paneManagers?.get(tabId)
      const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
      if (!pane) {
        throw new Error('No active terminal pane')
      }
      return `${tabId}:${pane.id}`
    })

    const terminalMarker = marker('LOCALHOST_SSH')
    await execInTerminal(orcaPage, ptyId, emitMarkerCommand(terminalMarker))
    await waitForTerminalOutput(orcaPage, terminalMarker, 20_000)

    // Why: managed hook scripts intentionally ignore Electron userData so
    // dev/prod Orca instances converge on the same installed command.
    const codexHookPath = path.join(os.homedir(), '.orca', 'agent-hooks', 'codex-hook.sh')
    const quotedCodexHookPath = shellQuote(codexHookPath)
    const codexHookStatus = await orcaPage.evaluate(() => window.api.agentHooks.codexStatus())
    expect(codexHookStatus.state).toBe('installed')
    const installMarker = marker('CODEX_HOOK_INSTALLED')
    const installFailedMarker = marker('CODEX_HOOK_INSTALL_FAILED')
    await execInTerminal(
      orcaPage,
      ptyId,
      [
        `if [ -x ${quotedCodexHookPath} ] && grep -F ${quotedCodexHookPath} "$HOME/.codex/hooks.json" >/dev/null 2>&1; then`,
        `  ${emitMarkerCommand(installMarker)}`,
        'else',
        `  ${emitMarkerCommand(installFailedMarker)}`,
        'fi'
      ].join('\n')
    )
    await waitForTerminalOutput(orcaPage, installMarker, 20_000)

    const envMarker = marker('AGENT_HOOK_ENV_OK')
    const envFailedMarker = marker('AGENT_HOOK_ENV_BAD')
    await execInTerminal(
      orcaPage,
      ptyId,
      [
        `if [ "$ORCA_PANE_KEY" = ${shellQuote(paneKey)} ] && [ -n "$ORCA_AGENT_HOOK_PORT" ] && [ -n "$ORCA_AGENT_HOOK_TOKEN" ] && /bin/sh -c 'test -n "$ORCA_PANE_KEY" && test -n "$ORCA_AGENT_HOOK_PORT" && test -n "$ORCA_AGENT_HOOK_TOKEN"'; then`,
        `  ${emitMarkerCommand(envMarker)}`,
        'else',
        '  token_state=${ORCA_AGENT_HOOK_TOKEN:+set}',
        `  printf '%s pane=%s port=%s token=%s endpoint=%s\\n' ${shellQuote(envFailedMarker)} "$ORCA_PANE_KEY" "$ORCA_AGENT_HOOK_PORT" "$token_state" "$ORCA_AGENT_HOOK_ENDPOINT"`,
        'fi'
      ].join('\n')
    )
    await waitForTerminalOutput(orcaPage, envMarker, 20_000)

    const prompt = `orca ssh e2e prompt ${Date.now()}`
    const hookPostedMarker = marker('AGENT_HOOK_POSTED')
    const hookPayloadFile = `/tmp/orca-e2e-hook-payload-${Date.now()}.json`
    await execInTerminal(
      orcaPage,
      ptyId,
      [
        `if [ ! -x ${quotedCodexHookPath} ]; then`,
        '  echo __ORCA_CODEX_HOOK_SCRIPT_MISSING__',
        'elif [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
        '  echo __ORCA_AGENT_HOOK_ENV_MISSING__',
        'else',
        `  printf '%s' ${shellQuote(
          JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt })
        )} > ${shellQuote(hookPayloadFile)}`,
        `  /bin/sh ${quotedCodexHookPath} < ${shellQuote(hookPayloadFile)}`,
        '  hook_status=$?',
        `  rm -f ${shellQuote(hookPayloadFile)}`,
        `  if [ "$hook_status" -eq 0 ]; then ${emitMarkerCommand(hookPostedMarker)}; fi`,
        'fi'
      ].join('\n')
    )
    await waitForTerminalOutput(orcaPage, hookPostedMarker, 20_000)

    await expect
      .poll(
        async () =>
          orcaPage.evaluate(
            ({ paneKey, prompt, targetId, worktreeId }) => {
              const state = window.__store?.getState()
              const entries = Object.values(state?.agentStatusByPaneKey ?? {})
              return entries.some(
                (entry) =>
                  entry.paneKey === paneKey &&
                  entry.prompt === prompt &&
                  entry.agentType === 'codex' &&
                  entry.state === 'working' &&
                  state?.repos.some((repo) => repo.connectionId === targetId) === true &&
                  Object.values(state?.worktreesByRepo ?? {})
                    .flat()
                    .some((worktree) => worktree.id === worktreeId)
              )
            },
            { paneKey, prompt, targetId: remote.targetId, worktreeId: remote.worktreeId }
          ),
        {
          timeout: 20_000,
          message: 'Remote Codex hook status did not reach the renderer agent-status store'
        }
      )
      .toBe(true)
  })
})
