import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DOCKER_SSH_RELAY_REMOTE_REPO_PATH,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { dockerExec, dockerWriteFile, shellQuote } from './ssh-codex-repro-remote-fixtures'

const REMOTE_CODEX_VERSION = '0.141.0'

function tomlString(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

export function installRemoteRealCodex(target: DockerSshRelayTarget): void {
  const codexAuthPath = path.join(os.homedir(), '.codex', 'auth.json')
  if (!existsSync(codexAuthPath)) {
    throw new Error(`Real remote Codex repro needs local auth at ${codexAuthPath}`)
  }
  dockerExec(target, 'mkdir -p /root/.codex')
  dockerWriteFile(target, '/root/.codex/auth.json', readFileSync(codexAuthPath), '600')
  const trustedRemotePath = tomlString(DOCKER_SSH_RELAY_REMOTE_REPO_PATH)
  dockerWriteFile(
    target,
    '/root/.codex/config.toml',
    [
      'approval_policy = "never"',
      '',
      `[projects."${trustedRemotePath}"]`,
      'trust_level = "trusted"',
      ''
    ].join('\n'),
    '600'
  )
  dockerExec(target, `npm install -g @openai/codex@${REMOTE_CODEX_VERSION}`, 180_000)
}

export function realRemoteCodexCommand(doneMarker: string): string {
  const prompt = [
    'This is an automated terminal rendering reproduction.',
    'Run these three shell commands one at a time, waiting for each one to finish before starting the next:',
    'node -e "let i = 0; const timer = setInterval(() => { console.log(\'REMOTE_CODEX_PHASE_0_\' + i); i += 1; if (i >= 100) clearInterval(timer) }, 250)"',
    'node -e "let i = 0; const timer = setInterval(() => { console.log(\'REMOTE_CODEX_PHASE_1_\' + i); i += 1; if (i >= 100) clearInterval(timer) }, 250)"',
    'node -e "let i = 0; const timer = setInterval(() => { console.log(\'REMOTE_CODEX_PHASE_2_\' + i); i += 1; if (i >= 100) clearInterval(timer) }, 250)"',
    'The commands are intentionally slow. Keep waiting until all three complete.',
    'Then briefly summarize that all three commands ran.',
    `End your final response with this exact marker: ${doneMarker}`
  ].join(' ')
  return [
    'codex',
    '--no-alt-screen',
    '--dangerously-bypass-approvals-and-sandbox',
    '--dangerously-bypass-hook-trust',
    '-C',
    shellQuote(DOCKER_SSH_RELAY_REMOTE_REPO_PATH),
    shellQuote(prompt)
  ].join(' ')
}
