import type { IDisposable, IParser, Terminal } from '@xterm/xterm'

export const DEFAULT_DA1_RESPONSE = '\x1b[?1;2c'
export const CONPTY_DA1_RESPONSE = '\x1b[?61;4c'

type TerminalCapabilityRepliesDeps = {
  terminal: Pick<Terminal, 'cols' | 'rows' | 'element' | 'options'>
  parser: Pick<IParser, 'registerCsiHandler' | 'registerOscHandler'>
  sendInput: (data: string) => boolean | void
  isReplaying: () => boolean
  da1Response?: string
}

function isPrimaryDeviceAttributesQuery(params: (number | number[])[]): boolean {
  return params.length === 0 || (params.length === 1 && params[0] === 0)
}

function getTerminalScreenElement(
  terminal: Pick<Terminal, 'element'>
): Pick<HTMLElement, 'getBoundingClientRect'> | null {
  if (typeof terminal.element?.querySelector !== 'function') {
    return null
  }
  return terminal.element.querySelector('.xterm-screen') ?? null
}

function measureCellPixels(
  terminal: Pick<Terminal, 'cols' | 'rows' | 'element'>
): { width: number; height: number } | null {
  if (terminal.cols <= 0 || terminal.rows <= 0) {
    return null
  }
  const rect = getTerminalScreenElement(terminal)?.getBoundingClientRect()
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    return null
  }
  return {
    width: Math.max(1, Math.round(rect.width / terminal.cols)),
    height: Math.max(1, Math.round(rect.height / terminal.rows))
  }
}

function disposeAll(disposables: IDisposable[]): void {
  for (const disposable of disposables) {
    disposable.dispose()
  }
}

function cssColorToOscRgb(value: string | undefined): string | null {
  if (!value) {
    return null
  }
  const trimmed = value.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed)?.[1]
  if (hex) {
    const expanded =
      hex.length === 3
        ? hex
            .split('')
            .map((char) => `${char}${char}`)
            .join('')
        : hex
    return `rgb:${byteHexToWord(expanded.slice(0, 2))}/${byteHexToWord(
      expanded.slice(2, 4)
    )}/${byteHexToWord(expanded.slice(4, 6))}`
  }
  const rgb = /^rgba?\(\s*([^)]+)\)$/i.exec(trimmed)
  if (!rgb) {
    return null
  }
  const channels = parseCssRgbChannels(rgb[1])
  if (!channels) {
    return null
  }
  const [red, green, blue] = channels.map((byte) => byte.toString(16).padStart(2, '0').repeat(2))
  return `rgb:${red}/${green}/${blue}`
}

function byteHexToWord(byte: string): string {
  return byte.repeat(2)
}

function parseCssRgbChannels(body: string): [number, number, number] | null {
  const colorPart = body.split('/')[0]?.trim()
  if (!colorPart) {
    return null
  }
  const components = colorPart.includes(',')
    ? colorPart.split(',').slice(0, 3)
    : colorPart.split(/\s+/).slice(0, 3)
  if (components.length !== 3) {
    return null
  }
  const channels = components.map((component) => parseCssRgbChannel(component.trim()))
  if (channels.some((channel) => channel === null)) {
    return null
  }
  return channels as [number, number, number]
}

function parseCssRgbChannel(component: string): number | null {
  const percent = /^(\d+(?:\.\d+)?)%$/.exec(component)?.[1]
  if (percent !== undefined) {
    return clampByte((Number(percent) / 100) * 255)
  }
  if (!/^\d+(?:\.\d+)?$/.test(component)) {
    return null
  }
  return clampByte(Number(component))
}

function clampByte(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)))
}

function isOscColorQuery(data: string): boolean {
  return data.trim() === '?'
}

export function createTerminalPixelSizeQueryResponder(
  terminal: Pick<Terminal, 'cols' | 'rows' | 'element'>,
  sendInput: (data: string) => boolean | void
): (data: string) => void {
  let pending = ''
  const respond = (reportsWindowPixels: boolean): void => {
    const cell = measureCellPixels(terminal)
    if (!cell) {
      return
    }
    const width = cell.width * (reportsWindowPixels ? terminal.cols : 1)
    const height = cell.height * (reportsWindowPixels ? terminal.rows : 1)
    sendInput(`\x1b[${reportsWindowPixels ? 4 : 6};${height};${width}t`)
  }
  return (data) => {
    const input = pending + data
    pending = input.endsWith('\x1b') || input.endsWith('\x1b[') ? input.slice(-2) : ''
    let offset = 0
    while (offset < input.length) {
      const queryIndex = input.indexOf('\x1b[', offset)
      if (queryIndex === -1) {
        break
      }
      const query = input.slice(queryIndex, queryIndex + 5)
      if (query === '\x1b[14t') {
        respond(true)
        offset = queryIndex + 5
        continue
      }
      if (query === '\x1b[16t') {
        respond(false)
        offset = queryIndex + 5
        continue
      }
      offset = queryIndex + 2
    }
  }
}

export function installTerminalCapabilityReplyHandlers(
  deps: TerminalCapabilityRepliesDeps
): IDisposable {
  const disposables = [
    deps.parser.registerCsiHandler({ final: 'c' }, (params) => {
      if (!isPrimaryDeviceAttributesQuery(params)) {
        return false
      }
      // Why: restored scrollback may contain old DA1 queries; answering those
      // into the fresh shell recreates the stray-input leak this handler fixes.
      if (!deps.isReplaying()) {
        deps.sendInput(deps.da1Response ?? DEFAULT_DA1_RESPONSE)
      }
      return true
    }),
    deps.parser.registerOscHandler(10, (data) => {
      if (!isOscColorQuery(data)) {
        return false
      }
      if (deps.isReplaying()) {
        return true
      }
      const foreground = cssColorToOscRgb(deps.terminal.options.theme?.foreground)
      if (!foreground) {
        return false
      }
      deps.sendInput(`\x1b]10;${foreground}\x1b\\`)
      return true
    }),
    deps.parser.registerOscHandler(11, (data) => {
      if (!isOscColorQuery(data)) {
        return false
      }
      if (deps.isReplaying()) {
        return true
      }
      const background = cssColorToOscRgb(deps.terminal.options.theme?.background)
      if (!background) {
        return false
      }
      deps.sendInput(`\x1b]11;${background}\x1b\\`)
      return true
    })
  ]

  return {
    dispose: () => disposeAll(disposables)
  }
}
