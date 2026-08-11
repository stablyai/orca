import { test } from './helpers/orca-app'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function remoteOscQueryScript(runId: string): string {
  return [
    "process.stdin.setEncoding('utf8')",
    'if (process.stdin.isTTY) process.stdin.setRawMode(true)',
    'process.stdin.resume()',
    "let received = ''",
    `process.stdout.write('REMOTE_OSC_READY_${runId}\\n')`,
    "process.stdin.on('data', (chunk) => {",
    '  received += chunk',
    "  if (received.includes('\\x1b]10;rgb:')) {",
    `    process.stdout.write('REMOTE_OSC_REPLY_${runId}\\n')`,
    '    process.exit(0)',
    '  }',
    '})',
    "setTimeout(() => process.stdout.write('\\x1b]10;?\\x1b\\\\'), 100)"
  ].join(';')
}

test.describe('PTY input write queue over SSH', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH E2E.')
  test.skip(process.platform === 'win32', 'Docker SSH E2E uses POSIX ssh tooling.')

  test('returns an xterm OSC query reply through the live SSH PTY', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      const runId = String(Date.now())

      await execInTerminal(orcaPage, ptyId, `node -e ${shellQuote(remoteOscQueryScript(runId))}`)
      await waitForTerminalOutput(orcaPage, `REMOTE_OSC_READY_${runId}`, 30_000, 80_000)
      await waitForTerminalOutput(orcaPage, `REMOTE_OSC_REPLY_${runId}`, 30_000, 80_000)
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
