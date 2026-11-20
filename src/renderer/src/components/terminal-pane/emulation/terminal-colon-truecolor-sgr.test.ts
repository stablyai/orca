// @vitest-environment happy-dom
import { Terminal } from '@xterm/xterm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

beforeEach(() => {
  // Why: happy-dom has no canvas, and the renderer measures text on open().
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    measureText: () => ({ width: 10 })
  } as unknown as CanvasRenderingContext2D)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.body.replaceChildren()
})

async function bgColorAfter(sequence: string): Promise<number | undefined> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const terminal = new Terminal()
  terminal.open(container)
  await new Promise<void>((resolve) => terminal.write(`\x1b[${sequence}m `, resolve))
  const cell = terminal.buffer.active.getLine(0)?.getCell(0)
  if (!cell) {
    throw new Error('cell not written')
  }
  expect(cell.isBgRGB(), `bg mode for ${sequence}`).toBe(true)
  return cell.getBgColor()
}

function rgb(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b
}

// The compact ITU T.416 colon form (48:2:r:g:b) misaligned RGB one slot left and
// dropped blue (#43868): the subparameter loop always consumed the first value as
// the colorspace slot, so 48:2:26:43:60 parsed as (43,60,0).
describe('colon-form truecolor SGR parsing (#43868)', () => {
  it('full-colon compact form parses direct RGB', async () => {
    expect(await bgColorAfter('48:2:26:43:60')).toBe(rgb(26, 43, 60))
  })

  it('semicolon-then-colon compact form parses direct RGB', async () => {
    expect(await bgColorAfter('48;2:26:43:60')).toBe(rgb(26, 43, 60))
  })

  it('pure red stays red, not lime or black', async () => {
    expect(await bgColorAfter('48:2:255:0:0')).toBe(rgb(255, 0, 0))
  })

  it('explicit empty colorspace form keeps parsing correctly', async () => {
    expect(await bgColorAfter('48:2::26:43:60')).toBe(rgb(26, 43, 60))
  })

  it('explicit colorspace id form keeps parsing correctly', async () => {
    expect(await bgColorAfter('48:2:0:26:43:60')).toBe(rgb(26, 43, 60))
  })

  it('semicolon form is unchanged', async () => {
    expect(await bgColorAfter('48;2;26;43;60')).toBe(rgb(26, 43, 60))
  })

  it('256-color colon form is unchanged', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const terminal = new Terminal()
    terminal.open(container)
    await new Promise<void>((resolve) => terminal.write('\x1b[48:5:196m ', resolve))
    const cell = terminal.buffer.active.getLine(0)?.getCell(0)
    expect(cell?.isBgPalette()).toBe(true)
    expect(cell?.getBgColor()).toBe(196)
  })
})
