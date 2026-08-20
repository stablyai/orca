import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote as dockerShellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget,
  writeDockerSshRelayTargetFile
} from './helpers/docker-ssh-relay-target'
import {
  execInTerminal,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const FISH_VERSION = '4.8.1'
const FISH_ASSETS = {
  aarch64: {
    asset: `fish-${FISH_VERSION}-linux-aarch64.tar.xz`,
    sha256: 'a03c8a445570a2a37e114cb13cebe41842cf17c4dd67a6530a57f742db04eee4'
  },
  x86_64: {
    asset: `fish-${FISH_VERSION}-linux-x86_64.tar.xz`,
    sha256: '39cab35242ab77bfdbce73b473000c3b045aaf2fe0951b042199bb7fdba3df78'
  }
} as const

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

function installRemoteFish(target: DockerSshRelayTarget): void {
  const arch = execDockerSshRelayTargetCommand(target, 'uname -m') as keyof typeof FISH_ASSETS
  const release = FISH_ASSETS[arch]
  if (!release) {
    throw new Error(`No pinned fish binary for Docker architecture ${arch}`)
  }
  const url = `https://github.com/fish-shell/fish-shell/releases/download/${FISH_VERSION}/${release.asset}`
  execDockerSshRelayTargetCommand(
    target,
    [
      `node -e ${dockerShellQuote("fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer() }).then(b => require('node:fs').writeFileSync('/tmp/fish.tar.xz', Buffer.from(b)))")} ${dockerShellQuote(url)}`,
      `echo ${dockerShellQuote(`${release.sha256}  /tmp/fish.tar.xz`)} | sha256sum -c -`,
      'tar -xJf /tmp/fish.tar.xz -C /usr/local/bin',
      'chmod 0755 /usr/local/bin/fish',
      '/usr/local/bin/fish --version'
    ].join(' && ')
  )
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

  test('keeps fish query replies out of the next child stdin on an upstream relay pty', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      installRemoteFish(target)
      const runId = String(Date.now())
      const home = `/tmp/orca-fish-${runId}`
      const prompt = `ORCA_SSH_FISH_${runId}> `
      const childReady = `CHILD_READY_${runId}`
      const childRead = `CHILD_READ_${runId}`
      execDockerSshRelayTargetCommand(
        target,
        `mkdir -p ${dockerShellQuote(`${home}/.config/fish`)} ${dockerShellQuote(`${home}/.local/share`)}`
      )
      writeDockerSshRelayTargetFile(
        target,
        `${home}/.config/fish/config.fish`,
        [
          'set -g fish_greeting ""',
          `function fish_prompt; printf ${dockerShellQuote(prompt)}; end`,
          'function fish_right_prompt; end',
          ''
        ].join('\n')
      )
      const childScript = `${home}/read-stdin.mjs`
      writeDockerSshRelayTargetFile(
        target,
        childScript,
        [
          `process.stdout.write(${JSON.stringify(`${childReady}\\n`)})`,
          "let buffered = ''",
          "process.stdin.on('data', chunk => {",
          "  buffered += chunk.toString('utf8')",
          "  if (!buffered.includes('\\n')) return",
          `  process.stdout.write(${JSON.stringify(`${childRead}:`)} + JSON.stringify(buffered) + '\\n')`,
          '  process.exit(0)',
          '})',
          ''
        ].join('\n')
      )

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await connectDockerSshRelayTarget(orcaPage, target)
      const relayExports = execDockerSshRelayTargetCommand(
        target,
        'module=$(find /root/.orca-remote -type d -path \'*/node_modules/node-pty\' | head -n 1); node -e "const p=require(process.argv[1]); console.log(Object.keys(p.native || {}).join(\',\'))" "$module"'
      )
      testInfo.annotations.push({ type: 'relay-node-pty-exports', description: relayExports })
      expect(relayExports).not.toContain('echoState')

      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
      await execInTerminal(
        orcaPage,
        ptyId,
        `env HOME=${shellQuote(home)} XDG_CONFIG_HOME=${shellQuote(`${home}/.config`)} XDG_DATA_HOME=${shellQuote(`${home}/.local/share`)} TERM=xterm-256color /usr/local/bin/fish -l -i`
      )
      await waitForTerminalOutput(orcaPage, prompt, 30_000, 80_000)

      const blocker = `node -e ${shellQuote(`console.log('BLOCKER_STARTED_${runId}'); setTimeout(() => process.exit(0), 5000)`)}`
      await execInTerminal(orcaPage, ptyId, blocker)
      await waitForTerminalOutput(orcaPage, `BLOCKER_STARTED_${runId}`, 30_000, 80_000)
      await execInTerminal(orcaPage, ptyId, `node ${shellQuote(childScript)}`)
      await waitForTerminalOutput(orcaPage, childReady, 30_000, 80_000)
      await sendToTerminal(orcaPage, ptyId, 'hello\r')
      await waitForTerminalOutput(orcaPage, `${childRead}:"hello\\n"`, 30_000, 80_000)
      const screenshotDir = path.join(process.cwd(), 'validation-screenshots', 'sta-3948')
      const screenshotPath = path.join(screenshotDir, 'linux-ssh-fish-child-stdin-pass.png')
      mkdirSync(screenshotDir, { recursive: true })
      await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
      await testInfo.attach('linux-ssh-fish-child-stdin-pass', {
        path: screenshotPath,
        contentType: 'image/png'
      })
    } finally {
      cleanupDockerSshRelayTarget(target)
    }
  })
})
