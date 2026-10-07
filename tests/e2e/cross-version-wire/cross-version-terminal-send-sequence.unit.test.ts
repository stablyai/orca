import { expect, test } from 'vitest'
import {
  RUNTIME_CAPABILITIES,
  TERMINAL_SEND_SEQUENCE_RUNTIME_CAPABILITY
} from '../../../src/shared/protocol-version'
import { createHostTerminalRuntimeStub } from './host-terminal-runtime-stub'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'
import { loadTerminalWireBuild, WORKING_TREE, type HostWire } from './versioned-terminal-wire'

type Sequence = { stream: string; seq: number }

/** One build's host with a fake PTY, and a way to send it input as a paired phone does. */
function pairedHost(host: HostWire) {
  const stub = createHostTerminalRuntimeStub()
  const dispatcher = new host.RpcDispatcher({
    runtime: stub.runtime,
    methods: host.TERMINAL_METHODS
  })
  let requests = 0
  const send = async (text: string, sequence?: Sequence): Promise<unknown> => {
    requests += 1
    const replies: string[] = []
    await dispatcher.dispatchStreaming(
      {
        id: `req-${requests}`,
        authToken: 'tok',
        method: 'terminal.send',
        params: {
          terminal: stub.terminalHandle,
          text,
          enter: false,
          client: { id: 'phone-1', type: 'mobile' },
          ...(sequence ? { sequence } : {})
        }
      },
      (message) => replies.push(message),
      {
        connectionId: 'connection-1',
        sendBinary: () => true,
        registerBinaryStreamHandler: () => () => {}
      }
    )
    return JSON.parse(replies.at(-1) ?? 'null')
  }
  return { stub, send }
}

async function baselineCapabilities(ref: string): Promise<readonly unknown[]> {
  const protocol = await importReleaseCheckoutModule(
    await materializeReleaseCheckout(ref),
    'src/shared/protocol-version.ts'
  )
  const capabilities = protocol.RUNTIME_CAPABILITIES
  if (!Array.isArray(capabilities)) {
    throw new Error(`Release ${ref} exports no runtime capability list`)
  }
  return capabilities
}

const ACCEPTED = { ok: true, result: { send: { accepted: true } } }

test('new client against old server: a send carrying a sequence is written like one without', async () => {
  const baseline = await loadTerminalWireBuild(resolveBaselineReleaseRef())
  const { stub, send } = pairedHost(baseline.host)

  expect(await send('plain')).toMatchObject(ACCEPTED)
  expect(await send('sequenced', { stream: 'keys', seq: 1 })).toMatchObject(ACCEPTED)

  expect(stub.writtenInput).toEqual(['plain', 'sequenced'])
}, 120_000)

test('new client against old server: the old server orders overlapping sends exactly when it says it does', async () => {
  const ref = resolveBaselineReleaseRef()
  const baseline = await loadTerminalWireBuild(ref)
  const advertised = (await baselineCapabilities(ref)).includes(
    TERMINAL_SEND_SEQUENCE_RUNTIME_CAPABILITY
  )
  const { stub, send } = pairedHost(baseline.host)

  // Dispatched in the wrong order: only a host that honours the sequence writes 'first' first.
  const second = send('second', { stream: 'keys', seq: 2 })
  const first = send('first', { stream: 'keys', seq: 1 })
  await Promise.all([first, second])

  // The capability is the client's only licence to overlap sends, so it must match the behaviour.
  expect(stub.writtenInput).toEqual(advertised ? ['first', 'second'] : ['second', 'first'])
}, 120_000)

test('old client against new server: sends without a sequence are written as they are dispatched', async () => {
  const current = await loadTerminalWireBuild(WORKING_TREE)
  const { stub, send } = pairedHost(current.host)

  expect(await send('one')).toMatchObject(ACCEPTED)
  expect(await send('two')).toMatchObject(ACCEPTED)

  expect(stub.writtenInput).toEqual(['one', 'two'])
})

test('new client against new server: sends dispatched out of order are written in sequence order', async () => {
  expect(RUNTIME_CAPABILITIES).toContain(TERMINAL_SEND_SEQUENCE_RUNTIME_CAPABILITY)
  const current = await loadTerminalWireBuild(WORKING_TREE)
  const { stub, send } = pairedHost(current.host)

  const second = send('second', { stream: 'keys', seq: 2 })
  const first = send('first', { stream: 'keys', seq: 1 })
  await Promise.all([first, second])

  expect(stub.writtenInput).toEqual(['first', 'second'])
})
