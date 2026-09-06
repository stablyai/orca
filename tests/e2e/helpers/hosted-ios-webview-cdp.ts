import net from 'node:net'
import { WebSocket } from 'ws'
import {
  hostedIosTerminalInputCaptureExpression,
  hostedIosTerminalInputCaptureInstallExpression,
  hostedIosTerminalReadyExpression
} from './hosted-ios-terminal-cdp-expressions'

const TARGET_LIST_MAX_BYTES = 1024 * 1024
const CDP_MESSAGE_MAX_BYTES = 2 * 1024 * 1024
const TARGET_LIMIT = 16

type CdpTarget = {
  id: string
  webSocketDebuggerUrl: string
}

type HostedDocument = {
  bodyText: string
  buttonCount: number
  href: string
  targetId: string
}

export async function findHostedIosInspectorPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('No inspector port'))
      )
    })
  })
}

export async function waitForHostedIosWorkspace(args: {
  discoveryUrl: string
  expectedText: string
  timeoutMs: number
}): Promise<HostedDocument> {
  const { discoveryUrl, expectedText, timeoutMs } = args
  const deadline = Date.now() + timeoutMs
  let lastSummary = 'No inspectable WebKit targets'
  while (Date.now() < deadline) {
    try {
      const targets = (await readTargets(discoveryUrl)).slice(-TARGET_LIMIT)
      const probes = (await Promise.all(targets.map((target) => probeDocument(target)))).filter(
        (probe): probe is HostedDocument => probe !== null
      )
      lastSummary = JSON.stringify({
        discoveredTargetIds: targets.map((target) => target.id),
        documents: probes.map(({ href, bodyText, buttonCount }) => ({
          href,
          textLength: bodyText.length,
          buttonCount
        }))
      })
      const selected = probes.find(
        (probe) =>
          probe.href.startsWith('orca-mobile-web://') &&
          probe.bodyText.toLowerCase().includes(expectedText.toLowerCase()) &&
          probe.buttonCount > 0
      )
      if (selected) {
        return selected
      }
    } catch (error) {
      lastSummary = error instanceof Error ? error.message : String(error)
    }
    await delay(500)
  }
  throw new Error(`Timed out waiting for hosted SSH workspace. Last targets: ${lastSummary}`)
}

export async function openHostedIosWorkspace(args: {
  discoveryUrl: string
  repoText: string
  workspaceText: string
  timeoutMs: number
}): Promise<void> {
  const expression = clickWorkspaceExpression(args.repoText, args.workspaceText)
  await waitForHostedIosEvaluation(
    args.discoveryUrl,
    args.timeoutMs,
    expression,
    (value) => value === 'clicked'
  )
  await waitForHostedIosEvaluation(
    args.discoveryUrl,
    args.timeoutMs,
    hostedIosTerminalReadyExpression,
    (value) => value === 'ready'
  )
}

export async function sendHostedIosTerminalCommand(args: {
  command: string
  discoveryUrl: string
  timeoutMs: number
  sendCommand: (
    command: string
  ) => Promise<{ expected: string; requireCarriageReturn: boolean } | void>
}): Promise<void> {
  await waitForHostedIosEvaluation(
    args.discoveryUrl,
    args.timeoutMs,
    hostedIosTerminalReadyExpression,
    (value) => value === 'ready'
  )
  await waitForHostedIosEvaluation(
    args.discoveryUrl,
    args.timeoutMs,
    hostedIosTerminalInputCaptureInstallExpression,
    (value) => value === 'installed'
  )
  const expectedCapture = (await args.sendCommand(args.command)) ?? {
    expected: args.command,
    requireCarriageReturn: true
  }
  await waitForHostedIosEvaluation(
    args.discoveryUrl,
    args.timeoutMs,
    hostedIosTerminalInputCaptureExpression,
    (value) =>
      value.includes(expectedCapture.expected) &&
      (!expectedCapture.requireCarriageReturn || value.includes('\r'))
  )
}

async function probeDocument(target: CdpTarget): Promise<HostedDocument | null> {
  const expression = `JSON.stringify({
    href: String(location.href).slice(0, 2048),
    bodyText: String(document.body?.innerText ?? '').slice(0, 8192),
    buttonCount: document.querySelectorAll('button,[role="button"],[tabindex="0"]').length
  })`
  try {
    const value = JSON.parse(await evaluate(target.webSocketDebuggerUrl, expression)) as {
      bodyText?: unknown
      buttonCount?: unknown
      href?: unknown
    }
    return typeof value.href === 'string' &&
      typeof value.bodyText === 'string' &&
      typeof value.buttonCount === 'number'
      ? { ...value, targetId: target.id }
      : null
  } catch {
    return null
  }
}

export async function waitForHostedIosEvaluation(
  discoveryUrl: string,
  timeoutMs: number,
  expression: string,
  accepted: (value: string) => boolean
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastResult = 'No hosted WebView'
  while (Date.now() < deadline) {
    for (const target of (await readTargets(discoveryUrl)).slice(-TARGET_LIMIT).toReversed()) {
      try {
        const value = await evaluate(target.webSocketDebuggerUrl, expression)
        lastResult = value
        if (accepted(value)) {
          return value
        }
      } catch (error) {
        lastResult = error instanceof Error ? error.message : String(error)
      }
    }
    await delay(500)
  }
  throw new Error(`Hosted WebView action timed out. Last result: ${lastResult}`)
}

async function readTargets(discoveryUrl: string): Promise<CdpTarget[]> {
  const response = await fetch(new URL('/json/list', discoveryUrl), {
    signal: AbortSignal.timeout(3_000)
  })
  if (!response.ok) {
    throw new Error(`WebKit inspector discovery returned HTTP ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > TARGET_LIST_MAX_BYTES) {
    throw new Error('WebKit inspector target list exceeded its size limit')
  }
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  return Array.isArray(parsed) ? parsed.filter(isSafeTarget) : []
}

function isSafeTarget(value: unknown): value is CdpTarget {
  if (
    !value ||
    typeof value !== 'object' ||
    !('id' in value) ||
    !('webSocketDebuggerUrl' in value) ||
    typeof value.id !== 'string' ||
    typeof value.webSocketDebuggerUrl !== 'string'
  ) {
    return false
  }
  try {
    const url = new URL(value.webSocketDebuggerUrl)
    return (
      url.protocol === 'ws:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      url.pathname.startsWith('/devtools/page/')
    )
  } catch {
    return false
  }
}

function evaluate(endpoint: string, expression: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { maxPayload: CDP_MESSAGE_MAX_BYTES })
    const timer = setTimeout(() => finish(new Error('WebKit CDP evaluation timed out')), 3_000)
    let settled = false
    const finish = (error?: Error, value?: string) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.close()
      if (error) {
        reject(error)
      } else {
        resolve(value ?? '')
      }
    }
    socket.once('open', () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, returnByValue: true }
        })
      )
    })
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(String(data)) as {
          error?: { message?: string }
          id?: number
          result?: { result?: { value?: unknown } }
        }
        if (message.id !== 1) {
          return
        }
        const value = message.result?.result?.value
        if (message.error || typeof value !== 'string') {
          finish(new Error(message.error?.message ?? 'WebKit CDP returned an invalid value'))
          return
        }
        finish(undefined, value)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.once('error', (error) => finish(error))
    socket.once('close', () => finish(new Error('WebKit CDP connection closed')))
  })
}

function clickWorkspaceExpression(repoText: string, workspaceText: string): string {
  return `(() => {
    const expectedRepo = ${JSON.stringify(repoText.toLowerCase())}
    const expectedWorkspace = ${JSON.stringify(workspaceText.toLowerCase())}
    const interactive = [...document.querySelectorAll('button,[role="button"],[tabindex="0"]')]
    const workspace = interactive
      .filter((element) =>
        String(element.textContent ?? '').toLowerCase().includes(expectedWorkspace)
      )
      .sort((left, right) => String(left.textContent).length - String(right.textContent).length)[0]
    if (workspace) {
      workspace.click()
      return 'clicked'
    }
    const repo = interactive
      .filter((element) => String(element.textContent ?? '').toLowerCase().includes(expectedRepo))
      .sort((left, right) => String(left.textContent).length - String(right.textContent).length)[0]
    if (!repo) return 'missing'
    repo.click()
    return 'expanded'
  })()`
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
