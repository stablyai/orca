import os from 'node:os'
import path from 'node:path'
import { readFileSync, realpathSync } from 'node:fs'
import { startCdpServer, type CdpServer } from 'inspect-webkit'
import type { ChildProcess } from 'node:child_process'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { parsePairingCode } from '../../src/shared/pairing'
import { RemoteRuntimeRequestConnection } from '../../src/shared/remote-runtime-request-connection'
import type { MobileWebPackageManifestResponse } from '../../src/shared/mobile-web/package-rpc-contract'
import { MobileWebManifestSchema } from '../../src/shared/mobile-web/manifest-contract'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { reconnectDisconnectedDockerSshRelayTarget } from './helpers/docker-ssh-relay-reconnect'
import {
  dockerSshNativeChatPublicationCommand,
  readDockerSshNativeChatPublisherDiagnostic,
  waitForDockerSshNativeChatPublication,
  waitForDockerSshNativeChatRuntimePublication,
  writeDockerSshNativeChatPublisher,
  writeDockerSshNativeChatTranscript
} from './helpers/docker-ssh-native-chat-fixture'
import {
  pairAndOpenHostedIosRoute,
  runHostedIosEmulatorCommand,
  resolveHostedIosSimulatorUdid,
  startHostedIosMobileLauncher,
  stopHostedIosMobileLauncher,
  waitForHostedIosMobileLauncher
} from './helpers/hosted-ios-mobile-launcher'
import { waitForHostedIosAccessibilityControl } from './helpers/hosted-ios-accessibility'
import { sendHostedIosPastedTerminalCommand } from './helpers/hosted-ios-pasted-terminal-command'
import { writeHostedIosSimulatorPasteboard } from '../../mobile/scripts/hosted-ios-terminal-clipboard-paste.mjs'
import { openHostedIosLongPressAction } from './helpers/hosted-ios-long-press'
import {
  findHostedIosInspectorPort,
  openHostedIosWorkspace,
  sendHostedIosTerminalCommand,
  waitForHostedIosEvaluation,
  waitForHostedIosWorkspace
} from './helpers/hosted-ios-webview-cdp'
import { waitForHostedIosNativeChat } from './helpers/hosted-ios-native-chat-cdp'
import { hostedIosNativeChatTabDiagnosticExpression } from './helpers/hosted-ios-native-chat-cdp-expressions'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree } from './helpers/store'
import { waitForActiveTerminalManager } from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const DEVICE = process.env.ORCA_E2E_IOS_DEVICE ?? 'iPhone 17 Pro'
const PACKAGED_MOBILE_WEB_RESOURCES = process.env.ORCA_E2E_PACKAGED_MOBILE_WEB_RESOURCES ?? null
const REMOTE_WORKSPACE = 'Docker SSH Relay E2E'
const REMOTE_WORKTREE = 'master'
const REMOTE_PROOF_PATH = '/tmp/orca-hosted-mobile-webview-ssh-proof'
const REMOTE_PROOF = 'HOSTED_MOBILE_WEBVIEW_SSH_OK'

test.use({ seedTestRepo: false })

test.describe('Hosted mobile WebView over Docker SSH', () => {
  test.setTimeout(360_000)
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform !== 'darwin', 'Hosted iOS WebView automation requires macOS.')

  test('renders terminal and native chat across an SSH reconnect', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const worktree = process.cwd()
    const orcaCli = path.join(worktree, 'config', 'scripts', 'orca-dev.mjs')
    const packagedBuild = PACKAGED_MOBILE_WEB_RESOURCES
      ? await configurePackagedMobileWebLookup(electronApp, PACKAGED_MOBILE_WEB_RESOURCES)
      : null
    let target: DockerSshRelayTarget | null = null
    let launcher: ChildProcess | null = null
    let inspector: CdpServer | null = null
    try {
      await registerCurrentWorktree(orcaPage, worktree)
      target = startDockerSshRelayTarget(testInfo)
      const remote = await connectDockerSshRelayTarget(orcaPage, target, {
        connectTimeoutMs: 120_000
      })
      await waitForActiveWorktree(orcaPage)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const pairingUrl = await createMobilePairingUrl(orcaPage, primaryLanAddress())
      const runtimePairing = parsePairingCode(pairingUrl)
      if (!runtimePairing) {
        throw new Error('Invalid runtime pairing URL')
      }
      if (packagedBuild) {
        await verifyPackagedMobileWebManifest(runtimePairing, packagedBuild.buildId)
      }
      const deviceUdid = await resolveHostedIosSimulatorUdid(DEVICE)
      const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
      launcher = startHostedIosMobileLauncher({
        deviceUdid,
        hostPublicKey: pairingPublicKey(pairingUrl),
        orcaCli,
        userDataDir,
        worktree
      })
      await waitForHostedIosMobileLauncher(launcher, 180_000)
      await pairAndOpenHostedIosRoute({
        deviceUdid,
        orcaCli,
        pairingUrl,
        userDataDir,
        worktree
      })

      const inspectorPort = await findHostedIosInspectorPort()
      inspector = await startCdpServer({ port: inspectorPort })
      const discoveryUrl = `http://127.0.0.1:${inspectorPort}`
      const hostedDocument = await waitForHostedIosWorkspace({
        discoveryUrl,
        expectedText: REMOTE_WORKSPACE,
        timeoutMs: 120_000
      })
      writeDockerSshNativeChatTranscript(target, [
        { id: 'u-1', role: 'user', text: 'remote hello' }
      ])
      writeDockerSshNativeChatPublisher(target)
      const terminalJourneyCommand = `${[
        `touch ${REMOTE_PROOF_PATH}`,
        dockerSshNativeChatPublicationCommand()
      ].join('; ')}; `
      // Why: Session snapshots clipboard availability on mount.
      await writeHostedIosSimulatorPasteboard(deviceUdid, terminalJourneyCommand)
      await openHostedIosWorkspace({
        discoveryUrl,
        repoText: REMOTE_WORKSPACE,
        timeoutMs: 90_000,
        workspaceText: REMOTE_WORKTREE
      })
      await sendHostedIosTerminalCommand({
        command: terminalJourneyCommand,
        discoveryUrl,
        timeoutMs: 30_000,
        sendCommand: (command) =>
          sendHostedIosPastedTerminalCommand(
            { deviceUdid, discoveryUrl, orcaCli, userDataDir, worktree },
            command
          )
      })
      await expect
        .poll(
          () =>
            execDockerSshRelayTargetCommand(
              target!,
              `test -f ${REMOTE_PROOF_PATH} && printf '${REMOTE_PROOF}' || true`
            ),
          { timeout: 30_000 }
        )
        .toBe(REMOTE_PROOF)
      await expect
        .poll(() => readDockerSshNativeChatPublisherDiagnostic(target!), {
          timeout: 10_000
        })
        .toContain('hook_exit=')
      await waitForDockerSshNativeChatPublication(orcaPage)
      const runtimeConnection = new RemoteRuntimeRequestConnection(runtimePairing)
      try {
        await waitForDockerSshNativeChatRuntimePublication(runtimeConnection, remote.worktreeId)
      } finally {
        runtimeConnection.close()
      }
      const terminalTabControl = await waitForHostedIosAccessibilityControl(
        { deviceUdid, orcaCli, userDataDir, worktree },
        'Terminal 1',
        20_000
      )
      const emulator = { deviceUdid, orcaCli, userDataDir, worktree }
      const chatAction = await openHostedIosLongPressAction(
        { ...emulator, discoveryUrl },
        terminalTabControl,
        'Terminal 1',
        'Switch to chat view'
      )
      await runHostedIosEmulatorCommand(emulator, [
        'tap',
        String(chatAction.x),
        String(chatAction.y)
      ])
      await waitForHostedIosNativeChat({
        discoveryUrl,
        expectedText: 'remote hello',
        timeoutMs: 30_000
      })
      await waitForHostedIosEvaluation(
        discoveryUrl,
        10_000,
        hostedIosNativeChatTabDiagnosticExpression,
        (value) => value.includes('"disconnectRetentions":[{')
      )

      await disconnectDockerSshRelayTarget(orcaPage, remote.targetId)
      await waitForHostedIosEvaluation(
        discoveryUrl,
        10_000,
        hostedIosNativeChatTabDiagnosticExpression,
        (value) => value.includes('"disconnectRetentions":[{')
      )
      await waitForHostedIosNativeChat({
        discoveryUrl,
        expectedPlaceholder: 'Reconnecting…',
        timeoutMs: 30_000
      })
      await reconnectDisconnectedDockerSshRelayTarget(orcaPage, remote.targetId, {
        connectTimeoutMs: 60_000
      })
      writeDockerSshNativeChatTranscript(target, [
        { id: 'u-1', role: 'user', text: 'remote hello' },
        { id: 'a-1', role: 'assistant', text: 'remote recovered' }
      ])
      await waitForHostedIosNativeChat({
        discoveryUrl,
        expectedText: 'remote recovered',
        expectedPlaceholder: 'Message, @files, /commands',
        timeoutMs: 60_000
      })

      console.log(
        JSON.stringify(
          {
            ok: true,
            device: deviceUdid,
            route: hostedDocument.href,
            targetId: hostedDocument.targetId,
            workspace: REMOTE_WORKSPACE,
            remoteProof: REMOTE_PROOF_PATH,
            nativeChat: ['remote hello', 'remote recovered'],
            packagedMobileWeb: packagedBuild
          },
          null,
          2
        )
      )
    } finally {
      inspector?.stop()
      await stopHostedIosMobileLauncher(launcher)
      cleanupDockerSshRelayTarget(target)
    }
  })
})

async function configurePackagedMobileWebLookup(
  electronApp: ElectronApplication,
  requestedResourcesPath: string
): Promise<{ buildId: string; resourcesPath: string }> {
  const resourcesPath = realpathSync(requestedResourcesPath)
  const packageRoot = path.join(resourcesPath, 'mobile-web')
  const manifest = MobileWebManifestSchema.parse(
    JSON.parse(readFileSync(path.join(packageRoot, 'manifest.json'), 'utf8'))
  )
  const state = await electronApp.evaluate(
    (_electron, args) => {
      const electronProcess = process as NodeJS.Process & { resourcesPath?: string }
      delete electronProcess.env.ORCA_MOBILE_WEB_PACKAGE_ROOT
      Object.defineProperty(electronProcess, 'resourcesPath', {
        configurable: true,
        enumerable: true,
        value: args.resourcesPath,
        writable: false
      })
      electronProcess.chdir(args.resourcesPath)
      return {
        cwd: electronProcess.cwd(),
        resourcesPath: electronProcess.resourcesPath
      }
    },
    { resourcesPath }
  )
  expect(state).toEqual({ cwd: resourcesPath, resourcesPath })
  return { buildId: manifest.buildId, resourcesPath }
}

async function verifyPackagedMobileWebManifest(
  pairing: NonNullable<ReturnType<typeof parsePairingCode>>,
  expectedBuildId: string
): Promise<void> {
  const connection = new RemoteRuntimeRequestConnection(pairing)
  try {
    const response = await connection.request<MobileWebPackageManifestResponse>(
      'mobileWeb.package.manifest',
      null,
      30_000
    )
    expect(response.ok).toBe(true)
    if (!response.ok) {
      throw new Error(response.error.message)
    }
    expect(response.result.manifest.buildId).toBe(expectedBuildId)
  } finally {
    connection.close()
  }
}

async function registerCurrentWorktree(
  page: Parameters<typeof waitForActiveWorktree>[0],
  worktree: string
): Promise<void> {
  await page.evaluate(async (repoPath) => {
    const result = await window.api.repos.add({ path: repoPath })
    if ('error' in result) {
      throw new Error(result.error)
    }
    const store = window.__store
    await store?.getState().fetchRepos()
    await store?.getState().fetchWorktrees(result.repo.id)
  }, worktree)
  await waitForActiveWorktree(page)
}

async function createMobilePairingUrl(
  page: Parameters<typeof waitForActiveWorktree>[0],
  address: string
): Promise<string> {
  return page.evaluate(async (pairingAddress) => {
    const offer = await window.api.mobile.getRuntimePairingUrl({
      address: pairingAddress,
      rotate: true
    })
    if (!offer.available || !offer.pairingUrl) {
      throw new Error('Runtime pairing unavailable')
    }
    return offer.pairingUrl
  }, address)
}

function pairingPublicKey(pairingUrl: string): string {
  const code = new URL(pairingUrl).searchParams.get('code')
  if (!code) {
    throw new Error('Invalid mobile pairing URL')
  }
  const offer = JSON.parse(Buffer.from(code, 'base64url').toString('utf8')) as {
    publicKeyB64?: unknown
  }
  if (typeof offer.publicKeyB64 !== 'string' || offer.publicKeyB64.length === 0) {
    throw new Error('Mobile pairing offer omitted its public identity')
  }
  return offer.publicKeyB64
}

function primaryLanAddress(): string {
  const candidates = Object.entries(os.networkInterfaces())
    .flatMap(([name, entries]) => (entries ?? []).map((entry) => ({ entry, name })))
    .filter(
      ({ entry, name }) =>
        entry.family === 'IPv4' &&
        !entry.internal &&
        !entry.address.startsWith('169.254.') &&
        !/^(awdl|bridge|gif|llw|p2p|stf|utun)/.test(name)
    )
    .sort(({ name: left }, { name: right }) => interfaceRank(left) - interfaceRank(right))
  return candidates[0]?.entry.address ?? '127.0.0.1'
}

function interfaceRank(name: string): number {
  return /^(en|eth|wlan)/.test(name) ? 0 : 1
}
