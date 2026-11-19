// A Slack event reaches a bot on a signed-in orcad server and its reply goes back through the
// connector; signing out or quitting stops the connector. orcad runs as built (packaged), so the
// fake Orca Cloud speaks HTTPS with a test CA instead of the dev-only plain HTTP.
// Build pnpm build:orcad and pnpm build:cli, then run electron-headless with ORCA_E2E_ORCAD_SERVE=1.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { RuntimeClient } from '../../../../src/cli/runtime/client'
import { pairedOwnerApp, type PairedOwnerApp } from '../bots/paired-owner-app'
import {
  LOCAL_HTTPS_TEST_CERTIFICATE,
  LOCAL_HTTPS_TEST_PRIVATE_KEY
} from '../../../../src/main/browser/electron-fixtures/browser-local-https-test-certificate'
import { expect } from '@stablyai/playwright-test'
import { test } from '../../desktop/electron-fixtures/orca-app'
import { cleanupE2EDaemons } from '../../desktop/electron-fixtures/electron-process-shutdown'
import { orcadNodeExecutable } from '../../layout/workspace-oracle/headless-layout-oracle-hosts'
import {
  cliServeProfile,
  spawnUntilReady,
  type ReadyProcess
} from '../../remote/paired-runtime/client-hosts/orca-serve-cli-host'
import { runCompiledOrcaCli } from '../../desktop/cli-invocation/compiled-orca-cli'
import { INHERITED_ORCA_IDENTITY_ENV_KEYS } from '../../../../src/main/ipc/pty/host-env/inherited-orca-identity-env'
import {
  claudeStubPath,
  SUPPORTED,
  writeClaudeStub,
  type ClaudeStub
} from '../../agents/session-fixtures/structured-claude-stub'
import {
  ACTIONS_TEAM,
  startConnectorActionsCloud,
  type ConnectorActionsCloud
} from './connector-actions-cloud-fixture'
import { AUTH_USER, startOrcaCloudAuth, type OrcaCloudAuth } from './orca-cloud-auth-fixture'

const RUN = process.env.ORCA_E2E_ORCAD_SERVE === '1'
const TLS = { key: LOCAL_HTTPS_TEST_PRIVATE_KEY, cert: LOCAL_HTTPS_TEST_CERTIFICATE }
const REPLY_TEXT = 'Looking at the deploys now.'
const INHERITED = 'inherited-'
const DEAD_ORIGIN = 'https://127.0.0.1:1'
const CONVERSATION = { source: 'slack', externalId: `${ACTIONS_TEAM}:C0E2E:1800000000.000200` }

test.describe.configure({ mode: 'serial' })

type Server = {
  profile: ReturnType<typeof cliServeProfile>
  orcad: ReadyProcess<string>
  /** The owner's app, paired over the server's offer: only it may make bots and connect Slack. */
  owner: PairedOwnerApp
}

const Readiness = z.object({ pairing: z.object({ url: z.string() }) })
const Ran = z.object({ ran: z.string(), output: z.string() })

let scratch = ''
let auth: OrcaCloudAuth
let connector: ConnectorActionsCloud
let stub: ClaudeStub
let server: Server

test.beforeAll(async () => {
  test.skip(!RUN, 'Set ORCA_E2E_ORCAD_SERVE=1 (and build out/orcad) to run the server bot journey.')
  test.skip(!SUPPORTED, 'the stub Claude runs through a POSIX wrapper')
  const node = orcadNodeExecutable()
  expect(node, 'pnpm build:orcad must produce out/orcad and its pinned Node').toBeTruthy()
  // Short (a unix socket path is capped near 104 bytes and the daemon's lives in userData) and
  // outside any temp dir, where orcad would refuse to seal a sign-in.
  scratch = mkdtempSync(path.join(os.homedir(), '.orca-cb-'))
  const stubDir = mkdtempSync(path.join(scratch, 'stub-'))
  const written = writeClaudeStub(stubDir)
  test.skip(!written, 'a system-wide claude would shadow the stub')
  stub = written!
  const caFile = path.join(scratch, 'fake-cloud-ca.pem')
  writeFileSync(caFile, LOCAL_HTTPS_TEST_CERTIFICATE)
  auth = await startOrcaCloudAuth(TLS)
  connector = await startConnectorActionsCloud({ tls: TLS })

  const profile = cliServeProfile(scratch)
  const env = {
    ...withoutAmbientOrca(profile.env),
    // As when orcad is started from an Orca terminal or agent: its identity must not reach the bot.
    ...Object.fromEntries(
      INHERITED_ORCA_IDENTITY_ENV_KEYS.map((key) => [key, `${INHERITED}${key}`])
    ),
    ORCA_USER_DATA: profile.userDataDir,
    ORCA_CLOUD_API_URL: auth.origin,
    ORCA_CLOUD_CLIENT_ID: 'orcad-connector-e2e',
    ORCA_CONNECTOR_URL: connector.origin,
    // Nothing listens there: no relay or push call can reach a real Orca service.
    ORCA_RELAY_URL: DEAD_ORIGIN,
    ORCA_PUSH_GATEWAY_URL: DEAD_ORIGIN,
    // Node trusts the fake cloud's certificate the way it would a corporate CA.
    NODE_EXTRA_CA_CERTS: caFile,
    PATH: claudeStubPath(stub)
  }
  const orcad = await spawnUntilReady({
    label: 'orcad serve',
    program: node!,
    args: [path.join('out', 'orcad', 'orcad.js'), '--bind', '127.0.0.1', '--port', '0', '--json'],
    env,
    timeoutMs: 120_000,
    parseReady: (stdout) => {
      const newline = stdout.indexOf('\n')
      return newline === -1 ? null : stdout.slice(0, newline)
    }
  })
  const ownerDir = mkdtempSync(path.join(scratch, 'owner-'))
  const { pairing } = Readiness.parse(JSON.parse(orcad.ready))
  server = { profile, orcad, owner: pairedOwnerApp(ownerDir, pairing.url) }
})

/** The launching Orca's own settings (hook endpoint, Claude config dir) stay out; identity is seeded above. */
function withoutAmbientOrca(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) =>
        !/^(?:ORCA_|CLAUDE)/.test(key) ||
        key === 'ORCA_BACKGROUND_LAUNCH' ||
        value !== process.env[key]
    )
  )
}

// oxlint-disable-next-line no-empty-pattern -- Playwright fixture callbacks require object destructuring here.
test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !server) {
    return
  }
  const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '(none)')
  const diagnostics = testInfo.outputPath('diagnostics.txt')
  writeFileSync(
    diagnostics,
    [
      `connector acks: ${JSON.stringify(connector.acks)}`,
      `connector events: ${JSON.stringify(connector.events)}`,
      `auth unknown paths: ${JSON.stringify(auth.unknownPaths)}`,
      `stub launches:\n${read(stub.launchLog)}`,
      `orcad stderr:\n${server.orcad.stderr().slice(-20_000)}`
    ].join('\n\n')
  )
  await testInfo.attach('diagnostics', { contentType: 'text/plain', path: diagnostics })
})

test.afterAll(async () => {
  await server?.orcad.stop()
  if (server) {
    await cleanupE2EDaemons(server.profile.userDataDir)
  }
  await connector?.close()
  await auth?.close()
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
  }
})

/** This build's CLI against the server, as a person on it (or its bot's agent) runs `orca`. */
function cliCommand(): string {
  return [
    `ORCA_USER_DATA_PATH='${server.profile.userDataDir}'`,
    'ORCA_DEV_CLI_INVOCATION=1',
    `'${process.execPath}'`,
    `'${path.join(process.cwd(), 'out', 'cli', 'index.js')}'`
  ].join(' ')
}

async function cli(args: string[]): Promise<unknown> {
  const run = await runCompiledOrcaCli(server.profile.userDataDir, [...args, '--json'])
  expect(run.code, `orca ${args.join(' ')}: ${run.stdout} ${run.stderr}`).toBe(0)
  return run.json?.result
}

const BotList = z.object({
  bots: z.array(z.object({ id: z.string() })),
  connectorStatus: z.string().optional()
})

async function connectorStatus(): Promise<string | undefined> {
  const { result } = await server.owner.call<unknown>('bots.list', {})
  return BotList.parse(result).connectorStatus
}

/** A Slack mention in the channel, as the cloud hands it to the machine its bot is on. */
function slackMention(botId: string, prompt: string) {
  return {
    deliveryId: `d-${Date.now()}`,
    expiresAt: Date.now() + 120_000,
    conversation: CONVERSATION,
    kind: 'start',
    agent: 'claude',
    placeId: Buffer.from(JSON.stringify(['bot', botId])).toString('base64url'),
    prompt
  }
}

let botId = ''

test('a Slack event reaches the bot on a signed-in server, and its reply goes back', async () => {
  // A sign-in, a bot, one connector hello and one stub agent turn that runs the CLI.
  test.setTimeout(180_000)
  const signedIn = z
    .object({ state: z.string(), email: z.string() })
    .parse(await cli(['auth', 'login']))
  expect(signedIn).toEqual({ state: 'signed-in', email: AUTH_USER.email })

  // As the owner's app makes one; the CLI only lets a bot propose one.
  const created = await server.owner.call('bots.create', { name: 'Scout', agent: 'claude' })
  botId = z.object({ bot: z.object({ id: z.string() }) }).parse(created.result).bot.id
  // A home-chat-only bot holds no connection; its first Slack app opens one.
  expect(connector.helloCount()).toBe(0)
  await server.owner.call('bots.update', {
    botId,
    updates: { slackApps: [{ appId: 'A0E2E', teamId: ACTIONS_TEAM }] }
  })
  await expect.poll(() => connector.knownBots(), { timeout: 30_000 }).toEqual([botId])
  // The token came from this server's own sign-in.
  expect(auth.mints.length).toBeGreaterThan(0)
  await expect.poll(connectorStatus, { timeout: 30_000 }).toBe('ok')

  connector.deliver(
    slackMention(
      botId,
      [
        'Are deploys failing?',
        'run: env',
        `run: ${cliCommand()} bot reply --text '${REPLY_TEXT}'`
      ].join('\n')
    )
  )

  await expect.poll(() => connector.replies, { timeout: 90_000 }).toHaveLength(1)
  expect(connector.replies[0]).toMatchObject({ conversation: CONVERSATION, text: REPLY_TEXT })
  // The bot's chat got the Slack message as its turn.
  const inputs = readFileSync(stub.inputLog, 'utf8')
  expect(inputs).toContain('Are deploys failing?')
  // None of orcad's inherited identity reached the bot's agent.
  const agentEnv = readFileSync(stub.launchLog, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const parsed = line ? Ran.safeParse(JSON.parse(line)) : null
      return parsed?.success && parsed.data.ran === 'env' ? [parsed.data.output] : []
    })
  expect(agentEnv).toHaveLength(1)
  expect(agentEnv[0]!.split('\n').filter((entry) => entry.includes(INHERITED))).toEqual([])
  expect(auth.unknownPaths).toEqual([])
})

test('signing the server out stops its connector: no more polls or deliveries', async () => {
  // A sign-out, a status poll, then a 3 s window with no requests.
  test.setTimeout(60_000)
  expect(botId, 'needs the signed-in bot from the previous test').not.toBe('')
  const signedOut = z.object({ state: z.string() }).parse(await cli(['auth', 'logout']))
  expect(signedOut.state).toBe('signed-out')
  expect(auth.logouts()).toBe(1)
  await expect.poll(connectorStatus, { timeout: 30_000 }).toBe('signed-out')

  const after = performance.now()
  const pending = slackMention(botId, 'Anyone there?')
  connector.deliver(pending)
  // ast-grep-ignore: test-no-real-time-wait -- an absence claim needs a window: three poll holds.
  await new Promise((resolve) => setTimeout(resolve, 3_000))
  expect(connector.requests.filter((request) => request.at >= after)).toEqual([])
  expect(connector.acks).not.toContainEqual(
    expect.objectContaining({ acks: [expect.objectContaining({ deliveryId: pending.deliveryId })] })
  )
})

test('quitting the server fences its connector before its RPC stops', async () => {
  // A second sign-in, a held RPC call, then orcad's graceful stop.
  test.setTimeout(90_000)
  // Signed in again, so the connector is polling when the server is told to quit.
  await cli(['auth', 'login'])
  await expect.poll(connectorStatus, { timeout: 30_000 }).toBe('ok')

  // An RPC call held open on the server: it ends only when the server's RPC stops.
  auth.approveSignIns(false)
  const local = new RuntimeClient(server.profile.userDataDir, 30_000, null, null)
  const Flow = z.object({
    flowId: z.string(),
    revision: z.number(),
    prompt: z.unknown().optional()
  })
  let flow = Flow.parse(
    (
      await local.call('orcaAccount.signIn.start', {
        switchAccount: true,
        approveInBrowser: true
      })
    ).result
  )
  while (!flow.prompt) {
    const waited = await local.call('orcaAccount.signIn.wait', {
      flowId: flow.flowId,
      afterRevision: flow.revision
    })
    flow = Flow.parse(waited.result)
  }
  let rpcEndedAt = 0
  const held = local
    .call(
      'orcaAccount.signIn.wait',
      { flowId: flow.flowId, afterRevision: flow.revision },
      { timeoutMs: 120_000 }
    )
    .then(
      () => 'answered',
      () => 'ended'
    )
    .finally(() => {
      rpcEndedAt = performance.now()
    })

  connector.holdPolls(true)
  const heldFrom = Date.now()
  await expect.poll(() => connector.lastPollAt(), { timeout: 30_000 }).toBeGreaterThan(heldFrom)

  const killedAt = performance.now()
  await server.orcad.stop()
  expect(await held).toBe('ended')
  expect(connector.lastPollDroppedAt()).toBeGreaterThanOrEqual(killedAt)
  // The poll was dropped while the server still answered RPC.
  expect(connector.lastPollDroppedAt()).toBeLessThan(rpcEndedAt)
  expect(
    connector.requests.filter((request) => request.at >= killedAt).map((request) => request.path)
  ).toEqual([])
})
