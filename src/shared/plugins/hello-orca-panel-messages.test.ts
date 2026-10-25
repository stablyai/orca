import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

describe('hello-orca panel replies', () => {
  it('only resolves an outstanding request once, from the parent window', async () => {
    const parent = { postMessage: vi.fn() }
    let receive: (event: { source: unknown; data: unknown }) => void = () => {
      throw new Error('Panel did not register its message listener')
    }
    const context = createContext({
      window: {
        parent,
        addEventListener: (name: string, listener: typeof receive) => {
          if (name === 'message') {
            receive = listener
          }
        }
      },
      document: { getElementById: () => ({ addEventListener: vi.fn() }) }
    })
    const html = readFileSync(
      new URL('../../../examples/plugins/hello-orca/panel.html', import.meta.url),
      'utf8'
    )
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
    if (!script) {
      throw new Error('Panel script missing')
    }
    runInContext(script, context)
    const resolved = vi.fn()
    const request = runInContext("call('workspace.readContext')", context).then(resolved)
    const reply = {
      type: 'orca-panel-action-result',
      requestId: 'req-1',
      ok: true,
      value: null
    }

    for (const requestId of ['__proto__', 'constructor', '__defineGetter__', 'unknown']) {
      expect(() => receive({ source: parent, data: { ...reply, requestId } })).not.toThrow()
    }
    receive({ source: {}, data: reply })
    await Promise.resolve()
    expect(resolved).not.toHaveBeenCalled()
    receive({ source: parent, data: reply })
    await request
    expect(resolved).toHaveBeenCalledExactlyOnceWith(reply)
    receive({ source: parent, data: reply })
    expect(runInContext('pending.size', context)).toBe(0)
    expect(parent.postMessage).toHaveBeenCalledExactlyOnceWith(
      {
        type: 'orca-panel-action',
        requestId: 'req-1',
        action: 'workspace.readContext',
        params: undefined
      },
      '*'
    )
  })
})
