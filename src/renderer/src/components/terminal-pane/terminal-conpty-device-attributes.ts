import type { IDisposable, IParser } from '@xterm/xterm'

export const CONPTY_DA1_RESPONSE = '\x1b[?61;4c'

type ConptyDeviceAttributesDeps = {
  parser: Pick<IParser, 'registerCsiHandler'>
  sendInput: (data: string) => boolean | void
  isReplaying: () => boolean
}

function isPrimaryDeviceAttributesQuery(params: (number | number[])[]): boolean {
  return params.length === 0 || (params.length === 1 && params[0] === 0)
}

export function installConptyDeviceAttributesHandler(
  deps: ConptyDeviceAttributesDeps
): IDisposable {
  return deps.parser.registerCsiHandler({ final: 'c' }, (params) => {
    if (!isPrimaryDeviceAttributesQuery(params)) {
      return false
    }
    // Why: ConPTY 1.22+ waits for a DA1 reply; replayed scrollback must not
    // answer old queries into the live shell.
    if (!deps.isReplaying()) {
      deps.sendInput(CONPTY_DA1_RESPONSE)
    }
    return true
  })
}
