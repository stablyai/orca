import { request } from 'node:http'

import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import {
  execDockerSshRelayTargetCommand,
  shellQuote,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export type PortForwardEvidence = {
  events: { targetId: string; forwards: { localPort: number; remotePort: number }[] }[]
  rendererForwards: { localPort: number; remotePort: number }[]
  managerForwards: { localPort: number; remotePort: number }[]
  persistedForwards: { localPort: number; remotePort: number }[]
}

export function requestForward(localPort: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: localPort, path: '/', method: 'GET', timeout: 2_000 },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          body += chunk
        })
        response.on('end', () => resolve(body))
      }
    )
    req.once('error', reject)
    req.once('timeout', () => req.destroy(new Error('Forwarded HTTP request timed out')))
    req.end()
  })
}

export function startRemoteHttpListener(
  target: DockerSshRelayTarget,
  port: number,
  marker: string
): number {
  const script = [
    "const http = require('node:http')",
    `const marker = ${JSON.stringify(marker)}`,
    "const server = http.createServer((_request, response) => response.end(marker + '\\n'))",
    `server.listen(${port}, '127.0.0.1')`
  ].join(';')
  execDockerSshRelayTargetCommand(
    target,
    [
      `nohup node -e ${shellQuote(script)} >/tmp/orca-http-${port}.log 2>&1 < /dev/null &`,
      `echo $! >/tmp/orca-http-${port}.pid`
    ].join(' ')
  )
  return Number(execDockerSshRelayTargetCommand(target, `cat /tmp/orca-http-${port}.pid`))
}

export function readRemoteListenerIdentity(
  target: DockerSshRelayTarget,
  port: number
): { pid: number; executable: string; command: string } {
  const pid = Number(execDockerSshRelayTargetCommand(target, `cat /tmp/orca-http-${port}.pid`))
  return {
    pid,
    executable: execDockerSshRelayTargetCommand(target, `readlink /proc/${pid}/exe`),
    command: execDockerSshRelayTargetCommand(target, `tr '\\000' ' ' </proc/${pid}/cmdline`)
  }
}

export async function installLifecycleWarningCapture(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __sshPortForwardWarnings?: string[]
      __sshPortForwardOriginalWarn?: typeof console.warn
    }
    scope.__sshPortForwardWarnings = []
    scope.__sshPortForwardOriginalWarn = console.warn
    console.warn = (...args: unknown[]) => {
      const message = args.map(String).join(' ')
      if (message.includes('[ssh')) {
        scope.__sshPortForwardWarnings?.push(message)
      }
      scope.__sshPortForwardOriginalWarn?.(...args)
    }
  })
}

export async function readLifecycleWarnings(electronApp: ElectronApplication): Promise<string[]> {
  return electronApp.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __sshPortForwardWarnings?: string[]
    }
    return scope.__sshPortForwardWarnings ?? []
  })
}

export async function restoreLifecycleWarningCapture(
  electronApp: ElectronApplication
): Promise<void> {
  await electronApp.evaluate(() => {
    const scope = globalThis as typeof globalThis & {
      __sshPortForwardWarnings?: string[]
      __sshPortForwardOriginalWarn?: typeof console.warn
    }
    if (scope.__sshPortForwardOriginalWarn) {
      console.warn = scope.__sshPortForwardOriginalWarn
    }
    delete scope.__sshPortForwardWarnings
    delete scope.__sshPortForwardOriginalWarn
  })
}

export async function installRendererForwardCapture(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as typeof window & {
      __sshPortForwardEvents?: unknown[]
      __sshPortForwardUnsubscribe?: () => void
    }
    scope.__sshPortForwardEvents = []
    scope.__sshPortForwardUnsubscribe?.()
    scope.__sshPortForwardUnsubscribe = window.api.ssh.onPortForwardsChanged((event) => {
      scope.__sshPortForwardEvents?.push(event)
    })
  })
}

export async function readPortForwardEvidence(
  page: Page,
  targetId: string
): Promise<PortForwardEvidence> {
  return page.evaluate(
    async ({ targetId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      const target = (await window.api.ssh.listTargets()).find((entry) => entry.id === targetId)
      const scope = window as typeof window & {
        __sshPortForwardEvents?: PortForwardEvidence['events']
      }
      return {
        events: scope.__sshPortForwardEvents ?? [],
        rendererForwards: store.getState().portForwardsByConnection[targetId] ?? [],
        managerForwards: await window.api.ssh.listPortForwards({ targetId }),
        persistedForwards: target?.portForwards ?? []
      }
    },
    { targetId }
  )
}

export async function openPortsPanel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.__store?.getState()
    state?.setRightSidebarTab('ports')
    state?.setRightSidebarOpen(true)
  })
  await expect(page.getByText('Ports', { exact: true }).last()).toBeVisible()
}

export async function forwardPortFromPanel(
  page: Page,
  localPort: number,
  remotePort: number
): Promise<void> {
  await page.getByRole('button', { name: 'Add', exact: true }).last().click()
  const dialog = page.getByRole('dialog', { name: 'Forward a Port' })
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Remote Port').fill(String(remotePort))
  await dialog.getByLabel('Local Port').fill(String(localPort))
  await dialog.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(dialog).not.toBeVisible()
}

export async function addPortForward(
  page: Page,
  args: {
    targetId: string
    localPort: number
    remotePort: number
    label: string
  }
): Promise<{ id: string }> {
  return page.evaluate(
    ({ targetId, localPort, remotePort, label }) =>
      window.api.ssh.addPortForward({
        targetId,
        localPort,
        remoteHost: '127.0.0.1',
        remotePort,
        label
      }),
    args
  )
}

export async function expectForwardEvidence(
  page: Page,
  targetId: string,
  expected: { localPort: number; remotePort: number }[]
): Promise<void> {
  await expect
    .poll(
      async () => {
        const evidence = await readPortForwardEvidence(page, targetId)
        return {
          renderer: evidence.rendererForwards.map(({ localPort, remotePort }) => ({
            localPort,
            remotePort
          })),
          manager: evidence.managerForwards.map(({ localPort, remotePort }) => ({
            localPort,
            remotePort
          })),
          persisted: evidence.persistedForwards.map(({ localPort, remotePort }) => ({
            localPort,
            remotePort
          }))
        }
      },
      { timeout: 30_000, message: 'renderer, manager, and persisted forward state did not agree' }
    )
    .toEqual({ renderer: expected, manager: expected, persisted: expected })
}
