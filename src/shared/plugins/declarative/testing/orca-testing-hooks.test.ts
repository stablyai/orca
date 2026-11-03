import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { acknowledgesByDefault } from './testing-host'
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

  it('answers fire-and-forget host methods with success by default', () => {
    expect(acknowledgesByDefault({ result: z.object({ ok: z.literal(true) }) })).toBe(true)
    expect(acknowledgesByDefault({ result: z.object({ delivered: z.boolean() }) })).toBe(false)
  })

  it('fires editor.save.before and returns the text the worker wrote', async () => {
    const formatter = {
      default(orca: {
        hooks: {
          on(hook: string, handler: (e: unknown, next: (e: unknown) => unknown) => unknown): unknown
        }
      }) {
        orca.hooks.on('editor.save.before', (event, next) =>
          next({ ...Object(event), text: `${String(Object(event).text).trim()}\n` })
        )
      }
    }
    const worker = await mountWorker(formatter, {
      events: [],
      commands: [],
      hooks: ['editor.save.before']
    })
    const save = { workspaceId: 'wt-1', path: 'src/a.ts', languageId: 'typescript', text: '  x  ' }
    await expect(worker.hooks.fire('editor.save.before', save)).resolves.toEqual({
      kind: 'continue',
      event: { ...save, text: 'x\n' }
    })
  })
})
