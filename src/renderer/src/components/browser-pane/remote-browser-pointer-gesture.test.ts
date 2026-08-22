import { describe, expect, it, vi } from 'vitest'
import {
  executeRemoteBrowserPointerCommands,
  getRemoteBrowserPointerCommands,
  type RemoteBrowserPointerSample
} from './remote-browser-pointer-gesture'

const start: RemoteBrowserPointerSample = {
  pointerId: 7,
  x: 100,
  y: 200,
  button: 'left',
  modifiers: ['cmd']
}

describe('remote browser pointer gesture', () => {
  it('routes a click through the atomic opcode supported by legacy hosts', () => {
    expect(getRemoteBrowserPointerCommands(start, { pointerId: 7, x: 100, y: 200 })).toEqual([
      {
        method: 'browser.mouseClick',
        params: { x: 100, y: 200, button: 'left', modifiers: ['cmd'] }
      }
    ])
  })

  it('keeps small physical pointer jitter on the atomic click path', () => {
    expect(getRemoteBrowserPointerCommands(start, { pointerId: 7, x: 104, y: 204 })).toEqual([
      {
        method: 'browser.mouseClick',
        params: { x: 104, y: 204, button: 'left', modifiers: ['cmd'] }
      }
    ])
  })

  it('preserves the existing remote drag sequence', () => {
    expect(getRemoteBrowserPointerCommands(start, { pointerId: 7, x: 140, y: 250 })).toEqual([
      { method: 'browser.mouseMove', params: { x: 100, y: 200 } },
      { method: 'browser.mouseDown', params: { button: 'left' } },
      { method: 'browser.mouseMove', params: { x: 140, y: 250 } },
      { method: 'browser.mouseUp', params: { button: 'left' } }
    ])
  })

  it('rejects a pointer-up from a different gesture', () => {
    expect(getRemoteBrowserPointerCommands(start, { pointerId: 8, x: 100, y: 200 })).toBeNull()
  })

  it('stops a superseded drag and releases its pressed button', async () => {
    let current = true
    const send = vi.fn(async (command) => {
      if (command.method === 'browser.mouseDown') {
        current = false
      }
    })
    const release = vi.fn()
    const commands = getRemoteBrowserPointerCommands(start, { pointerId: 7, x: 140, y: 250 })!

    await expect(
      executeRemoteBrowserPointerCommands(commands, { isCurrent: () => current, send, release })
    ).resolves.toBe(false)

    expect(send.mock.calls.map(([command]) => command.method)).toEqual([
      'browser.mouseMove',
      'browser.mouseDown'
    ])
    expect(release).toHaveBeenCalledWith('left')
  })

  it('releases a mouseDown that rejects before acknowledgement', async () => {
    const error = new Error('ack lost')
    const release = vi.fn()
    const commands = getRemoteBrowserPointerCommands(start, { pointerId: 7, x: 140, y: 250 })!

    await expect(
      executeRemoteBrowserPointerCommands(commands, {
        isCurrent: () => true,
        send: async (command) => {
          if (command.method === 'browser.mouseDown') {
            throw error
          }
        },
        release
      })
    ).rejects.toBe(error)
    expect(release).toHaveBeenCalledWith('left')
  })
})
