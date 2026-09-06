import { expect } from 'vitest'
import {
  createOrderedInputPtyTestRig,
  inputProofDeadline
} from '../../../src/main/runtime/rpc/terminal-ordered-input-pty-test-rig'
import type { MobileTerminalWireBuild } from './versioned-mobile-terminal-wire'
import { openMobileInputWireSession } from './mobile-input-wire-session'

const INPUTS = ['BOM:\ufeff한글\nline-2', '\t\x1b[A\x7f\x03', '\r']

export async function runMobileInputSkewJourney(
  host: MobileTerminalWireBuild,
  client: MobileTerminalWireBuild
) {
  const expected = Buffer.from(INPUTS.join(''))
  const rig = await createOrderedInputPtyTestRig(expected)
  let session: Awaited<ReturnType<typeof openMobileInputWireSession>> | undefined
  let unsubscribe: (() => void) | undefined
  let echo: unknown
  try {
    session = await openMobileInputWireSession(host, client, rig.runtime)
    const { rpc } = session
    let subscribed!: () => void
    const subscription = new Promise<void>((resolve) => {
      subscribed = resolve
    })
    unsubscribe = rpc.subscribe(
      'terminal.subscribe',
      {
        terminal: 'terminal-1',
        client: { id: 'phone', type: 'mobile' },
        capabilities: { terminalBinaryStream: 1 }
      },
      (result) => {
        const event = result as { type?: string; capabilities?: unknown }
        if (event.type === 'subscribed') {
          echo = event.capabilities
          subscribed()
        }
      }
    )
    await inputProofDeadline(subscription, 'mobile skew subscription')
    const ordered = rpc.supportsTerminalStreamInput?.('terminal-1') === true
    for (const text of INPUTS) {
      if (ordered) {
        expect(
          await inputProofDeadline(
            rpc.sendTerminalStreamInput!('terminal-1', text)!,
            'mobile skew receipt'
          )
        ).toBe(true)
      } else {
        expect(
          await rpc.sendRequest('terminal.send', { terminal: 'terminal-1', text })
        ).toMatchObject({ ok: true })
      }
    }
    await inputProofDeadline(rig.inputDelivered, 'mobile skew PTY delivery')
    expect(rig.bytes()).toEqual(expected)
    const { binaryInputs, jsonInputs } = session.counts()
    expect(binaryInputs).toBe(ordered ? INPUTS.length : 0)
    expect(jsonInputs).toBe(ordered ? 0 : INPUTS.length)
    expect(session.errors).toEqual([])
    return {
      host: host.revision,
      client: client.revision,
      ordered,
      offered: session.offered(),
      echo,
      binaryInputs,
      jsonInputs,
      hex: rig.bytes().toString('hex')
    }
  } finally {
    try {
      unsubscribe?.()
      await session?.dispose()
    } finally {
      await rig.close()
    }
  }
}
