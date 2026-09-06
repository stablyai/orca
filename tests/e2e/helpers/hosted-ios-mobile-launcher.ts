import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { dismissEmulatorDeveloperMenuBeforePairing } from '../../../mobile/scripts/emulator-developer-menu-dismissal.mjs'
import { openHostedIosHybridRoute } from '../../../mobile/scripts/hosted-ios-hybrid-route-handoff.mjs'
import {
  readHostedIosAccessibilityNodes,
  waitForHostedIosAccessibilityControl,
  type HostedIosAccessibilityNode
} from './hosted-ios-accessibility'
import { runHostedIosEmulatorCommand } from './hosted-ios-emulator-command'

export {
  runHostedIosEmulatorCommand,
  type HostedIosEmulatorCommandOptions
} from './hosted-ios-emulator-command'

const execFileAsync = promisify(execFile)

type HostedIosMobileLauncherOptions = {
  deviceUdid: string
  hostPublicKey: string
  orcaCli: string
  userDataDir: string
  worktree: string
}

export async function resolveHostedIosSimulatorUdid(requested: string): Promise<string> {
  const { stdout } = await execFileAsync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])
  const devices = Object.values(
    (
      JSON.parse(stdout) as {
        devices?: Record<string, { name?: string; state?: string; udid?: string }[]>
      }
    ).devices ?? {}
  ).flat()
  const matches = devices.filter((device) => device.udid === requested || device.name === requested)
  const selected = matches.find((device) => device.state === 'Booted') ?? matches[0]
  if (!selected?.udid) {
    throw new Error(`No available iOS Simulator matched "${requested}".`)
  }
  return selected.udid
}

export function startHostedIosMobileLauncher({
  deviceUdid,
  hostPublicKey,
  orcaCli,
  userDataDir,
  worktree
}: HostedIosMobileLauncherOptions): ChildProcess {
  const runDirectory = hostedIosRunDirectory(worktree)
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
  return spawn(
    process.execPath,
    [
      path.join(worktree, 'mobile', 'scripts', 'start-emulator.mjs'),
      '--worktree',
      worktree,
      '--device',
      deviceUdid,
      '--no-pair',
      '--wait-for-ready'
    ],
    {
      cwd: worktree,
      env: {
        ...process.env,
        EXPO_PUBLIC_ORCA_E2E_MOBILE_WEB_HOST_PUBLIC_KEY: hostPublicKey,
        ORCA_CLI: orcaCli,
        ORCA_DEV_USER_DATA_PATH: userDataDir,
        ORCA_E2E_MOBILE_RUN_DIRECTORY: runDirectory,
        ORCA_USER_DATA_PATH: userDataDir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
}

export function waitForHostedIosMobileLauncher(
  child: ChildProcess,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    let outputTail = ''
    let settled = false
    const timer = setTimeout(
      () => finish(new Error(`Mobile launcher timed out.\n${outputTail}`)),
      timeoutMs
    )
    const consume = (chunk: Buffer, target: NodeJS.WriteStream) => {
      const text = String(chunk)
      target.write(text)
      outputTail = (outputTail + text).slice(-32 * 1024)
      if (outputTail.includes('Setup complete!')) {
        finish()
      }
    }
    const finish = (error?: Error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      child.off('exit', handleExit)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const handleExit = (code: number | null) => {
      finish(new Error(`Mobile launcher exited with code ${code}.\n${outputTail}`))
    }
    child.stdout?.on('data', (chunk: Buffer) => consume(chunk, process.stdout))
    child.stderr?.on('data', (chunk: Buffer) => consume(chunk, process.stderr))
    child.once('error', finish)
    child.once('exit', handleExit)
  })
}

export async function pairAndOpenHostedIosRoute(args: {
  deviceUdid: string
  orcaCli: string
  pairingUrl: string
  userDataDir: string
  worktree: string
}): Promise<void> {
  const { deviceUdid, pairingUrl } = args
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await execFileAsync('xcrun', ['simctl', 'openurl', deviceUdid, pairingUrl])
    await delay(2_000)
  }
  await dismissEmulatorDeveloperMenuBeforePairing(args, 20_000)
  const pairControl = await waitForHostedIosAccessibilityControl(args, 'Pair', 20_000)
  await runHostedIosEmulatorCommand(args, ['tap', String(pairControl.x), String(pairControl.y)])
  await waitForPairingCompletion(args, 45_000)
  await openHostedIosHybridRoute(args, 45_000)
}

export async function stopHostedIosMobileLauncher(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) {
    return
  }
  child.kill('SIGTERM')
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill('SIGKILL')
      }
    })
  ])
}

function hostedIosRunDirectory(worktree: string): string {
  const key = createHash('sha256').update(worktree).digest('hex').slice(0, 16)
  return path.join('/tmp', `orca-mobile-webview-ssh-e2e-${key}`)
}

async function waitForPairingCompletion(
  args: Parameters<typeof pairAndOpenHostedIosRoute>[0],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastLabels: string[] = []
  while (Date.now() < deadline) {
    const first = await readHostedIosAccessibilityNodes(args)
    lastLabels = accessibilityLabels(first)
    const error = lastLabels.find(
      (label) =>
        label.includes('Pairing failed') ||
        label.includes("Couldn't connect") ||
        label.includes('Invalid pairing')
    )
    if (error) {
      throw new Error(`Mobile pairing failed: ${error}`)
    }
    if (!hasPairingStage(lastLabels)) {
      await delay(500)
      const confirmationLabels = accessibilityLabels(await readHostedIosAccessibilityNodes(args))
      if (!hasPairingStage(confirmationLabels)) {
        return
      }
      lastLabels = confirmationLabels
    }
    await delay(250)
  }
  throw new Error(`Mobile pairing did not complete. Last labels: ${summarizeLabels(lastLabels)}`)
}

function accessibilityLabels(nodes: HostedIosAccessibilityNode[]): string[] {
  return nodes.flatMap((node) =>
    [node.label, node.value].filter((value): value is string => Boolean(value))
  )
}

function hasPairingStage(labels: string[]): boolean {
  return labels.some(
    (label) => label === 'Pair' || label === 'Pair with this desktop?' || label === 'Connecting…'
  )
}

function summarizeLabels(labels: string[]): string {
  return JSON.stringify(labels.slice(0, 40))
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
