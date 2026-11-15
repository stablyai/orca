import { describe, expect, it } from 'vitest'
import { splitTerminalInputChunks } from './terminal-input'
import '../../clipboard/clipboard-text'

describe('terminal input bounds', () => {
  it('splits by UTF-8 bytes without splitting surrogate pairs', () => {
    const chunks = splitTerminalInputChunks('ab😀cd', 4)

    expect(chunks).toEqual(['ab', '😀', 'cd'])
    expect(chunks.join('')).toBe('ab😀cd')
  })

  it('keeps a single multibyte terminal character intact when the byte cap is smaller', () => {
    const chunks = splitTerminalInputChunks('😀a', 1)

    expect(chunks).toEqual(['😀', 'a'])
    expect(chunks.join('')).toBe('😀a')
  })
})
