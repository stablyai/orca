import { execFileSync } from 'node:child_process'
import type { Page } from '@stablyai/playwright-test'
import {
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

// Container-side fixture location. Space-free so the seeded custom agent's v1
// args template tokenizes it to a single argument (mirrors the local spec).
export const REMOTE_CUSTOM_AGENT_FIXTURE_PATH = '/tmp/orca-custom-agent-fixture.cjs'

export type ConnectedRemoteWorktree = {
  targetId: string
  repoId: string
  worktreeId: string
}

export type RemoteAgentProcess = {
  pid: number
  argv: string[]
  env: Map<string, string>
}

function dockerRun(args: string[], timeoutMs = 60_000): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs
  })
}

/** Copy the deterministic agent fixture into the container so the host-resolved
 *  custom executable (`node <fixture>`) runs on the REMOTE, not the local host. */
export function placeCustomAgentFixtureInContainer(
  target: DockerSshRelayTarget,
  localFixturePath: string
): void {
  dockerRun(['cp', localFixturePath, `${target.containerName}:${REMOTE_CUSTOM_AGENT_FIXTURE_PATH}`])
}

/** Read the live agent process(es) inside the container via /proc — the real
 *  spawned argv (cmdline) and environment (environ), NUL-separated. This proves
 *  the host launched THIS executable on the remote with exactly this argv/env,
 *  which a mocked HTTP handler could never observe. */
export function observeRemoteAgentProcesses(target: DockerSshRelayTarget): RemoteAgentProcess[] {
  const raw = dockerRun([
    'exec',
    target.containerName,
    'bash',
    '-lc',
    // -f matches the full cmdline; `|| true` keeps a zero-match exit non-fatal.
    `pgrep -f ${REMOTE_CUSTOM_AGENT_FIXTURE_PATH} || true`
  ]).trim()
  if (raw.length === 0) {
    return []
  }
  const processes: RemoteAgentProcess[] = []
  for (const line of raw.split('\n')) {
    const pid = Number(line.trim())
    if (!Number.isInteger(pid) || pid <= 0) {
      continue
    }
    let cmdline: string
    let environ: string
    try {
      cmdline = dockerRun(['exec', target.containerName, 'bash', '-lc', `cat /proc/${pid}/cmdline`])
      environ = dockerRun(['exec', target.containerName, 'bash', '-lc', `cat /proc/${pid}/environ`])
    } catch {
      // The process may exit between pgrep and the /proc read; skip it.
      continue
    }
    const argv = cmdline.split('\0').filter((part) => part.length > 0)
    // Only the node process running the fixture is the launched agent; a shell
    // wrapper whose cmdline merely mentions the path is not argv[0]-node.
    const executable = argv[0]?.split('/').at(-1)
    if (executable !== 'node') {
      continue
    }
    const env = new Map<string, string>()
    for (const pair of environ.split('\0')) {
      if (pair.length === 0) {
        continue
      }
      const eq = pair.indexOf('=')
      if (eq <= 0) {
        continue
      }
      env.set(pair.slice(0, eq), pair.slice(eq + 1))
    }
    processes.push({ pid, argv, env })
  }
  return processes
}

/** Add the Docker SSH target, connect the relay, register the seeded remote
 *  repo, and activate its worktree — the connectDockerRemote pattern, returning
 *  the identifiers a custom-agent launch and a reconnect attempt both need. */
export async function connectDockerRemoteWorktree(
  page: Page,
  target: DockerSshRelayTarget
): Promise<ConnectedRemoteWorktree> {
  return await page.evaluate(
    async ({ target, remotePath }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const credentialUnsub = window.api.ssh.onCredentialRequest((request) => {
        void window.api.ssh.submitCredential({ requestId: request.requestId, value: null })
      })
      try {
        const { target: createdTarget, repoReadoptions } = await window.api.ssh.addTarget({
          target: {
            label: `Docker SSH Custom Agent ${Date.now()}`,
            // Why target.host, not a literal loopback: ORCA_E2E_SSH_TARGET_HOST
            // moves the container off 127.0.0.1 for non-local runners.
            host: target.host,
            port: target.port,
            username: 'root',
            identityFile: target.identityFile,
            identitiesOnly: true,
            relayGracePeriodSeconds: 1
          }
        })
        store.getState().recordSshRepoReadoptions(repoReadoptions)
        const state = await window.api.ssh.connect({ targetId: createdTarget.id })
        if (!state || state.status !== 'connected') {
          throw new Error(`SSH target did not connect: ${JSON.stringify(state)}`)
        }
        // Worktree hydration over direct SSH needs a complete authority; without
        // it fetchWorktrees silently returns nothing instead of failing here.
        if (!state.providerEpoch || !Number.isSafeInteger(state.connectionGeneration)) {
          throw new Error(`SSH target returned incomplete authority: ${JSON.stringify(state)}`)
        }
        store.getState().setSshConnectionState(createdTarget.id, state)
        const labels = new Map(store.getState().sshTargetLabels)
        labels.set(createdTarget.id, createdTarget.label)
        store.getState().setSshTargetLabels(labels)
        const executionHostId = `ssh:${encodeURIComponent(createdTarget.id)}` as const

        const result = await window.api.repos.addRemote({
          connectionId: createdTarget.id,
          remotePath,
          displayName: 'Docker SSH Custom Agent'
        })
        if ('error' in result) {
          throw new Error(result.error)
        }
        await store.getState().fetchRepos()
        await store.getState().fetchWorktrees(result.repo.id, { executionHostId })
        const worktree = (store.getState().worktreesByRepo[result.repo.id] ?? []).find(
          (candidate) => candidate.hostId === executionHostId
        )
        if (!worktree) {
          throw new Error(`No remote worktree found for ${result.repo.path}`)
        }
        store.getState().setActiveWorktree(worktree.id)
        return {
          targetId: createdTarget.id,
          repoId: result.repo.id,
          worktreeId: worktree.id
        }
      } finally {
        credentialUnsub()
      }
    },
    { target, remotePath: DOCKER_SSH_RELAY_REMOTE_REPO_PATH }
  )
}

/** Kill and re-establish the relay connection so a reconnect-settle attempt can
 *  observe whether the launch token settles without a duplicate PTY. */
export async function reconnectDockerTarget(page: Page, targetId: string): Promise<void> {
  await page.evaluate(async (targetId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    await window.api.ssh.disconnect({ targetId })
    const state = await window.api.ssh.connect({ targetId })
    if (!state || state.status !== 'connected') {
      throw new Error(`SSH target did not reconnect: ${JSON.stringify(state)}`)
    }
    store.getState().setSshConnectionState(targetId, state)
  }, targetId)
}
