// The host-side runtime-source fence, paired across two builds over a real socket: current code
// against the newest published release's host. Release checkouts carry no CLI sources, and an old
// CLI's frame is exactly the current one without the field, so the old client is the current
// transport sending none.
//
// A new CLI adds an optional `expectedRuntimeSource` to its request frame. Each skew must hold:
//
//  - an old CLI sends no expectation, and a new host runs its request as before;
//  - an old host ignores the field and runs the request (the CLI's pre-send probe is then the only
//    fence), so a new CLI never breaks against it;
//  - a new host refuses a request meant for another runtime before its handler runs.

import { createServer, type Server } from 'node:net'
import { randomUUID } from 'node:crypto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { publishHostDescriptor } from '../../../src/main/runtime/host-descriptor'
import type { RuntimeMetadata } from '../../../src/shared/runtime-bootstrap'
import type { ExpectedRuntimeSource } from '../../../src/shared/runtime-rpc-envelope'
import { sendRequest } from '../../../src/cli/runtime/transport'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

// Why: a cold CI run extracts the baseline checkout before the first pairing.
const SUITE_TIMEOUT_MS = 180_000
const RUNTIME_ID = 'runtime-a'
const SOURCE_A = '11111111-1111-4111-8111-111111111111'
const SOURCE_B = '22222222-2222-4222-8222-222222222222'

type Dispatcher = { dispatch(request: unknown): Promise<unknown> }
type HostBuild = (effect: () => unknown) => Dispatcher

function member<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the module exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a release module is typed unknown; the name is the same export this build calls, and a missing one throws above.
  return value as T
}

function hostBuildOf(
  dispatcher: Record<string, unknown>,
  core: Record<string, unknown>
): HostBuild {
  const RpcDispatcher = member<
    new (options: { runtime: unknown; methods: unknown[] }) => Dispatcher
  >(dispatcher, 'RpcDispatcher')
  const defineMethod = member<(declaration: Record<string, unknown>) => unknown>(
    core,
    'defineMethod'
  )
  return (effect) =>
    new RpcDispatcher({
      runtime: { getRuntimeId: () => RUNTIME_ID },
      methods: [
        defineMethod({
          name: 'terminal.send',
          permission: 'workspace',
          params: z.object({ text: z.string() }),
          handler: effect
        })
      ]
    })
}

const servers: Server[] = []

async function serve(host: Dispatcher): Promise<RuntimeMetadata> {
  const dir = mkdtempSync(join(tmpdir(), 'orca-source-fence-wire-'))
  const isWindows = process.platform === 'win32'
  const endpoint = isWindows
    ? `\\\\.\\pipe\\orca-source-fence-wire-${randomUUID()}`
    : join(dir, 'runtime.sock')
  const server = createServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        void host
          .dispatch(JSON.parse(buffer.slice(0, newline)))
          .then((response) => socket.end(`${JSON.stringify(response)}\n`))
      }
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(endpoint, resolve))
  return {
    runtimeId: RUNTIME_ID,
    pid: 1,
    transports: [{ kind: isWindows ? 'named-pipe' : 'unix', endpoint }],
    authToken: 'token',
    startedAt: 1
  }
}

let releasedHost: HostBuild
let currentHost: HostBuild

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const load = (path: string) => importReleaseCheckoutModule(checkout, path)
  const [oldDispatcher, oldCore, newDispatcher, newCore] = await Promise.all([
    load('src/main/runtime/rpc/dispatcher.ts'),
    load('src/main/runtime/rpc/core.ts'),
    import('../../../src/main/runtime/rpc/dispatcher'),
    import('../../../src/main/runtime/rpc/core')
  ])
  releasedHost = hostBuildOf(oldDispatcher, oldCore)
  currentHost = hostBuildOf(newDispatcher, newCore)
  publishHostDescriptor(RUNTIME_ID, { installationId: SOURCE_A })
}, SUITE_TIMEOUT_MS)

afterAll(async () => {
  publishHostDescriptor(RUNTIME_ID, null)
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

async function call(
  host: HostBuild,
  expectedRuntimeSource?: ExpectedRuntimeSource
): Promise<{ response: { ok: boolean; error?: { code: string } }; ran: number }> {
  let ran = 0
  const metadata = await serve(
    host(() => {
      ran += 1
      return { sent: true }
    })
  )
  const response = await sendRequest(
    metadata,
    'terminal.send',
    { text: 'hi' },
    5_000,
    undefined,
    expectedRuntimeSource
  )
  return { response, ran }
}

describe('runtime-source fence across versions', () => {
  it('pairs two real host builds', () => {
    expect(releasedHost).not.toBe(currentHost)
  })

  it('an old CLI sends no expectation, and a new host runs its request', async () => {
    const { response, ran } = await call(currentHost)
    expect(response).toMatchObject({ ok: true })
    expect(ran).toBe(1)
  })

  it('an old host ignores a new CLI’s expectation rather than refusing', async () => {
    const { response, ran } = await call(releasedHost, {
      sourceId: SOURCE_A,
      runtimeId: RUNTIME_ID
    })
    expect(response).toMatchObject({ ok: true })
    expect(ran).toBe(1)
  })

  it('a new host refuses a new CLI’s request meant for another runtime before running it', async () => {
    const { response, ran } = await call(currentHost, {
      sourceId: SOURCE_B,
      runtimeId: RUNTIME_ID
    })
    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_source_mismatch' } })
    expect(ran).toBe(0)
  })

  it('a new host runs a new CLI’s request meant for it and advertises the fence', async () => {
    const { response, ran } = await call(currentHost, {
      sourceId: SOURCE_A,
      runtimeId: RUNTIME_ID
    })
    expect(response).toMatchObject({ ok: true })
    expect(ran).toBe(1)
    expect(RUNTIME_CAPABILITIES).toContain(RUNTIME_SOURCE_FENCE_RUNTIME_CAPABILITY)
  })
})
