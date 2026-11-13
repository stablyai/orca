import { describe, expect, it } from 'vitest'
import { mountWorker } from './orca-testing'

type HookOrca = {
  hooks: { on(hook: string, handler: (event: unknown) => unknown): unknown }
}

const send = { terminalId: 't', text: 'rm -rf /', enter: true, inputKind: 'driving' }

const throwingGuard = {
  default(orca: HookOrca) {
    orca.hooks.on('terminal.send', () => {
      throw new Error('status bar down')
    })
  }
}

describe('orca/testing hooks', () => {
  it('fails closed for a hook listed with onError: deny, and open otherwise', async () => {
    const closed = await mountWorker(throwingGuard, {
      events: [],
      commands: [],
      hooks: [{ event: 'terminal.send', onError: 'deny' }]
    })
    await expect(closed.hooks.fire('terminal.send', send)).resolves.toEqual({
      kind: 'deny',
      reason: 'worker failed and denies on error: status bar down'
    })
    const open = await mountWorker(throwingGuard, {
      events: [],
      commands: [],
      hooks: ['terminal.send']
    })
    await expect(open.hooks.fire('terminal.send', send)).resolves.toEqual({
      kind: 'continue',
      event: send
    })
  })
})
