import { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindTerminalKittyFileReader, readTerminalKittyFile } from './terminal-kitty-file-reader'
const terminals: Terminal[] = []
function terminal(): Terminal {
  const value = new Terminal()
  terminals.push(value)
  return value
}
const request = () => ({
  path: '/fixture/image.png',
  offset: 0,
  signal: new AbortController().signal
})
afterEach(() => terminals.splice(0).forEach((value) => value.dispose()))
describe('terminal Kitty file reader ownership', () => {
  it('fails closed when the terminal has no owner', async () => {
    await expect(readTerminalKittyFile(terminal(), request())).rejects.toThrow('unavailable')
  })
  it('does not use another terminal reader', async () => {
    const first = terminal()
    const second = terminal()
    const reader = vi.fn(async () => new Uint8Array([1]))
    const cleanup = bindTerminalKittyFileReader(first, reader)
    await expect(readTerminalKittyFile(second, request())).rejects.toThrow('unavailable')
    expect(reader).not.toHaveBeenCalled()
    cleanup()
  })
  it('older connection cleanup preserves its replacement', async () => {
    const value = terminal()
    const first = vi.fn(async () => new Uint8Array([1]))
    const second = vi.fn(async () => new Uint8Array([2]))
    const cleanFirst = bindTerminalKittyFileReader(value, first)
    const cleanSecond = bindTerminalKittyFileReader(value, second)
    cleanFirst()
    await expect(readTerminalKittyFile(value, request())).resolves.toEqual(new Uint8Array([2]))
    expect(first).not.toHaveBeenCalled()
    cleanSecond()
    await expect(readTerminalKittyFile(value, request())).rejects.toThrow('unavailable')
  })
  it('passes the request and abort signal unchanged', async () => {
    const value = terminal()
    const reader = vi.fn(async () => new Uint8Array([1, 2]))
    const cleanup = bindTerminalKittyFileReader(value, reader)
    const input = { ...request(), offset: 10, length: 12 }
    await expect(readTerminalKittyFile(value, input)).resolves.toEqual(new Uint8Array([1, 2]))
    expect(reader).toHaveBeenCalledWith(input)
    cleanup()
  })
})
