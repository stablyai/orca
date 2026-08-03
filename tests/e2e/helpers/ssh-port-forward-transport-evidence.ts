import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import {
  execDockerSshRelayTargetCommand,
  shellQuote,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

type CapturedSshState = {
  status: string
  providerEpoch?: string
  connectionGeneration?: number
}

export async function trustDockerSshHost(
  electronApp: ElectronApplication,
  target: DockerSshRelayTarget
): Promise<string> {
  const sshDir = join(target.tempDir, '.ssh')
  mkdirSync(sshDir, { recursive: true })
  const knownHostsPath = join(sshDir, 'known_hosts')
  const hostKeys = execFileSync('ssh-keyscan', ['-p', String(target.port), '127.0.0.1'], {
    encoding: 'utf8'
  })
  writeFileSync(knownHostsPath, hostKeys)
  const invocationLogPath = join(target.tempDir, 'system-ssh-invocations')
  const wrapperPath = join(target.tempDir, 'verified-system-ssh')
  writeFileSync(
    wrapperPath,
    [
      '#!/bin/sh',
      'kind=transport',
      'for arg in "$@"; do',
      '  if [ "$arg" = "-L" ]; then kind=forward; fi',
      'done',
      `printf '%s\\n' "$kind" >> ${shellQuote(invocationLogPath)}`,
      `exec /usr/bin/ssh -o UserKnownHostsFile=${shellQuote(knownHostsPath)} -o StrictHostKeyChecking=yes "$@"`
    ].join('\n')
  )
  chmodSync(wrapperPath, 0o755)
  await electronApp.evaluate((_electron, path) => {
    process.env.ORCA_SYSTEM_SSH_PATH = path
  }, wrapperPath)
  return invocationLogPath
}

export function readSystemSshInvocationKinds(invocationLogPath: string): string[] {
  if (!existsSync(invocationLogPath)) {
    return []
  }
  return readFileSync(invocationLogPath, 'utf8').split(/\r?\n/).filter(Boolean)
}

export function terminateDockerSshRelayConnectChannel(target: DockerSshRelayTarget): number {
  const output = execDockerSshRelayTargetCommand(
    target,
    `
count=0
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  argv=()
  mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || continue
  [ "\${argv[1]##*/}" = relay.js ] || continue
  mode=
  for arg in "\${argv[@]:2}"; do
    if [ "$arg" = --connect ]; then mode=connect; fi
    if [ "$arg" = --detached ]; then mode=detached; fi
  done
  if [ "$mode" = connect ]; then
    kill -TERM "\${proc##*/}"
    count=$((count + 1))
  fi
done
printf '%s' "$count"
`
  )
  return Number(output)
}

export async function installSshStateCapture(page: Page, targetId: string): Promise<void> {
  await page.evaluate((targetId) => {
    const scope = window as typeof window & {
      __sshLifecycleStates?: CapturedSshState[]
      __sshLifecycleStateUnsubscribe?: () => void
    }
    scope.__sshLifecycleStateUnsubscribe?.()
    scope.__sshLifecycleStates = []
    scope.__sshLifecycleStateUnsubscribe = window.api.ssh.onStateChanged((event) => {
      if (event.targetId === targetId) {
        scope.__sshLifecycleStates?.push(event.state)
      }
    })
  }, targetId)
}

export async function readSshStateCapture(page: Page): Promise<CapturedSshState[]> {
  return page.evaluate(
    () =>
      (
        window as typeof window & {
          __sshLifecycleStates?: CapturedSshState[]
        }
      ).__sshLifecycleStates ?? []
  )
}

export async function forceDockerSshRelayChannelReconnect(
  page: Page,
  target: DockerSshRelayTarget,
  targetId: string
): Promise<void> {
  await installSshStateCapture(page, targetId)
  const authority = await page.evaluate(
    (targetId) => window.__store?.getState().sshConnectionStates.get(targetId),
    targetId
  )
  expect(authority).toMatchObject({
    status: 'connected',
    providerEpoch: expect.any(String),
    connectionGeneration: expect.any(Number)
  })
  expect(terminateDockerSshRelayConnectChannel(target)).toBeGreaterThan(0)
  await expect
    .poll(
      async () => {
        const states = await readSshStateCapture(page)
        const current = await page.evaluate(
          (targetId) => window.__store?.getState().sshConnectionStates.get(targetId),
          targetId
        )
        return (
          states.some((state) => state.status === 'reconnecting') &&
          states.some((state) => state.status === 'connected') &&
          current?.status === 'connected' &&
          (current.providerEpoch !== authority?.providerEpoch ||
            current.connectionGeneration !== authority?.connectionGeneration)
        )
      },
      { timeout: 30_000, message: 'in-place relay channel did not reconnect' }
    )
    .toBe(true)
}
