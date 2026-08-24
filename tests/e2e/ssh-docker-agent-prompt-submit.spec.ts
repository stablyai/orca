import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import type { Page } from '@stablyai/playwright-test'
import {
  AGENT_PROMPT_SUBMIT,
  buildAgentPromptPasteBytes
} from '../../src/shared/agent-prompt-injection'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetControlCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget,
  writeDockerSshRelayTargetFile
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const REMOTE_AGENT = '/tmp/codex'
const REMOTE_INPUT = '/tmp/orca-codex-prompt-input.bin'
const REMOTE_REPORT = '/tmp/orca-codex-prompt-report.json'
const PS_OBSERVE = '/tmp/orca-prompt-ps-observe'
const PS_FAIL = '/tmp/orca-prompt-ps-fail-once'
const PS_ENTERED = '/tmp/orca-prompt-ps-entered'
const PS_RELEASE = '/tmp/orca-prompt-ps-release'
const PS_RETRY = '/tmp/orca-prompt-ps-retry'
const PS_RETRY_ENTERED = '/tmp/orca-prompt-ps-retry-entered'
const PS_RETRY_RELEASE = '/tmp/orca-prompt-ps-retry-release'
const PS_COUNT = '/tmp/orca-prompt-ps-count'
const TERMINAL_CLOSE_CLEANUP_TIMEOUT_MS = 5_000
const execFileAsync = promisify(execFile)

type RuntimeTerminalSummary = {
  handle: string
  ptyId: string | null
  executionHostId?: string
}

async function callRuntime<TResult>(page: Page, method: string, params: unknown): Promise<TResult> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { method, params }
  ) as Promise<TResult>
}

async function closeRemoteTerminalsBestEffort(page: Page, handles: string[]): Promise<void> {
  let timeout: NodeJS.Timeout | null = null
  try {
    await Promise.race([
      Promise.all(
        handles.map((terminal) =>
          callRuntime(page, 'terminal.closeTab', { terminal }).catch(() => undefined)
        )
      ),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, TERMINAL_CLOSE_CLEANUP_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timeout) {
      clearTimeout(timeout)
    }
  }
}

async function createRemoteTerminal(
  page: Page,
  worktreeId: string,
  command: string,
  title: string
): Promise<RuntimeTerminalSummary> {
  const result = await callRuntime<{ terminal: RuntimeTerminalSummary }>(page, 'terminal.create', {
    worktree: `id:${worktreeId}`,
    command,
    title,
    presentation: 'background'
  })
  if (!result.terminal.ptyId) {
    throw new Error(`Remote terminal ${result.terminal.handle} has no PTY`)
  }
  return result.terminal
}

function installControlledPs(target: DockerSshRelayTarget): void {
  const script = `#!/usr/bin/env bash
if [ -e ${PS_OBSERVE} ]; then
  count=0
  [ ! -r ${PS_COUNT} ] || count="$(cat ${PS_COUNT})"
  printf '%s' "$((count + 1))" > ${PS_COUNT}
  if rm -f ${PS_FAIL} 2>/dev/null && [ ! -e ${PS_ENTERED} ]; then
    printf entered > ${PS_ENTERED}
    while [ ! -e ${PS_RELEASE} ]; do sleep 0.02; done
    exit 1
  fi
  if rm -f ${PS_RETRY} 2>/dev/null && [ ! -e ${PS_RETRY_ENTERED} ]; then
    printf retry > ${PS_RETRY_ENTERED}
    while [ ! -e ${PS_RETRY_RELEASE} ]; do sleep 0.02; done
    exit 1
  fi
fi
exec /usr/bin/ps "$@"
`
  writeDockerSshRelayTargetFile(target, '/usr/local/bin/ps', script)
  execDockerSshRelayTargetControlCommand(target, 'chmod 755 /usr/local/bin/ps')
}

function prepareRemoteAgent(target: DockerSshRelayTarget): void {
  const fixture = readFileSync(
    path.join(process.cwd(), 'tests', 'tools', 'repro-terminal-send-submit.mjs'),
    'utf8'
  )
  writeDockerSshRelayTargetFile(target, REMOTE_AGENT, fixture)
  installControlledPs(target)
}

function remoteFile(target: DockerSshRelayTarget, filePath: string): string {
  try {
    return execDockerSshRelayTargetControlCommand(
      target,
      `test -r ${shellQuote(filePath)} && cat ${shellQuote(filePath)}`
    )
  } catch {
    return ''
  }
}

function remoteInput(target: DockerSshRelayTarget): string {
  try {
    const encoded = execDockerSshRelayTargetControlCommand(
      target,
      `test -r ${shellQuote(REMOTE_INPUT)} && base64 -w0 ${shellQuote(REMOTE_INPUT)}`
    )
    return Buffer.from(encoded, 'base64').toString('utf8')
  } catch {
    return ''
  }
}

function armHalfOpenInspection(target: DockerSshRelayTarget): void {
  execDockerSshRelayTargetControlCommand(
    target,
    `rm -f ${REMOTE_INPUT} ${REMOTE_REPORT} ${PS_ENTERED} ${PS_RELEASE} ${PS_RETRY_ENTERED} ${PS_RETRY_RELEASE} ${PS_COUNT}; ` +
      `: > ${PS_OBSERVE}; : > ${PS_FAIL}; : > ${PS_RETRY}`
  )
}

async function waitForRemoteSignal(
  target: DockerSshRelayTarget,
  filePath: string
): Promise<string> {
  const result = await execFileAsync(
    'docker',
    [
      'exec',
      target.containerName,
      'bash',
      '--noprofile',
      '--norc',
      '-c',
      `while [ ! -r ${shellQuote(filePath)} ]; do sleep 0.02; done; cat ${shellQuote(filePath)}`
    ],
    { encoding: 'utf8', timeout: 10_000 }
  )
  return result.stdout.trim()
}

test.describe('Docker SSH settled prompt submission', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker SSH relay tests.')
  test.skip(process.platform === 'win32', 'Docker SSH relay tests use POSIX ssh tooling.')

  test('waits through a half-open wrapper inspection before one remote Enter', async ({
    orcaPage
  }, testInfo) => {
    test.setTimeout(180_000)
    let target: DockerSshRelayTarget | null = null
    const terminalHandles: string[] = []
    try {
      target = startDockerSshRelayTarget(testInfo)
      prepareRemoteAgent(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      const marker = `SSH_SETTLED_PROMPT_${Date.now()}`
      const survivor = await createRemoteTerminal(
        orcaPage,
        remote.worktreeId,
        'bash',
        'unrelated remote shell'
      )
      terminalHandles.push(survivor.handle)
      const terminal = await createRemoteTerminal(
        orcaPage,
        remote.worktreeId,
        `node ${REMOTE_AGENT} --fake-agent --report ${REMOTE_REPORT} --marker ${marker} --input-observation ${REMOTE_INPUT} --timeout-ms 60000`,
        'remote prompt fixture'
      )
      terminalHandles.push(terminal.handle)
      expect(terminal.ptyId).not.toBe(survivor.ptyId)
      await expect
        .poll(async () => {
          const read = await callRuntime<{ terminal: { tail: string[] } }>(
            orcaPage,
            'terminal.read',
            { terminal: terminal.handle }
          )
          return read.terminal.tail.join('\n')
        })
        .toContain('OpenAI Codex')
      expect(terminal.executionHostId).toBe(`ssh:${encodeURIComponent(remote.targetId)}`)

      armHalfOpenInspection(target)
      const inspectionEntered = waitForRemoteSignal(target, PS_ENTERED)
      const inspection = callRuntime(orcaPage, 'terminal.inspectProcess', {
        terminal: terminal.handle
      })
      await expect(inspectionEntered).resolves.toBe('entered')
      const prompt = `${marker} remote wrapper payload`
      let sendSettled = false
      const send = callRuntime<{ send: { accepted: boolean; bytesWritten: number } }>(
        orcaPage,
        'terminal.send',
        {
          terminal: terminal.handle,
          text: prompt,
          enter: true,
          agentPrompt: true,
          client: { id: 'docker-ssh-e2e', type: 'desktop' }
        }
      ).finally(() => {
        sendSettled = true
      })

      expect(sendSettled).toBe(false)
      expect(remoteInput(target)).toBe('')
      execDockerSshRelayTargetControlCommand(target, `: > ${PS_RELEASE}`)
      await expect(inspection).resolves.toBeTruthy()
      await expect(waitForRemoteSignal(target, PS_RETRY_ENTERED)).resolves.toBe('retry')
      expect(remoteInput(target)).toBe('')
      expect(sendSettled).toBe(false)
      execDockerSshRelayTargetControlCommand(target, `: > ${PS_RETRY_RELEASE}`)

      await expect(send).resolves.toMatchObject({ send: { accepted: true } })
      await expect.poll(() => remoteFile(target!, REMOTE_REPORT)).not.toBe('')
      const observedInput = remoteInput(target)
      expect(observedInput).toBe(`${buildAgentPromptPasteBytes(prompt)}${AGENT_PROMPT_SUBMIT}`)
      expect(JSON.parse(remoteFile(target, REMOTE_REPORT))).toMatchObject({
        contractOk: true,
        submitted: true,
        prematureEnters: 0,
        receivedEnters: 1,
        markerReceived: true
      })
      const psCalls = Number(remoteFile(target, PS_COUNT))
      expect(psCalls).toBeGreaterThanOrEqual(2)
      expect(psCalls).toBeLessThanOrEqual(8)

      const survivorMarker = `SSH_UNRELATED_SURVIVES_${Date.now()}`
      await callRuntime(orcaPage, 'terminal.send', {
        terminal: survivor.handle,
        text: `printf '${survivorMarker}\\n'`,
        enter: true,
        client: { id: 'docker-ssh-e2e', type: 'desktop' }
      })
      await expect
        .poll(async () => {
          const read = await callRuntime<{ terminal: { tail: string[] } }>(
            orcaPage,
            'terminal.read',
            { terminal: survivor.handle }
          )
          return read.terminal.tail.join('\n')
        })
        .toContain(survivorMarker)

      testInfo.annotations.push({
        type: 'docker-ssh-settled-prompt',
        description: `target=${remote.targetId} worktree=${remote.worktreeId} agentPty=${terminal.ptyId} survivorPty=${survivor.ptyId} psCalls=${remoteFile(target, PS_COUNT)}`
      })
    } finally {
      try {
        await closeRemoteTerminalsBestEffort(orcaPage, terminalHandles)
      } finally {
        if (target) {
          try {
            execDockerSshRelayTargetControlCommand(
              target,
              `rm -f ${PS_OBSERVE} ${PS_FAIL} ${PS_RELEASE} ${PS_RETRY} ${PS_RETRY_RELEASE}`
            )
          } finally {
            cleanupDockerSshRelayTarget(target)
          }
        } else {
          cleanupDockerSshRelayTarget(target)
        }
      }
    }
  })
})
