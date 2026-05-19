import type { Terminal, IDisposable } from '@xterm/xterm'

type TerminalCommandLifecycleOptions = {
  onCommandFinished: (bestEffortExitCode: number | null) => void
}

type OscTerminator = {
  index: number
  length: number
}

const OSC_133_PREFIX = '\x1b]133;'
const MAX_OSC_CARRY_LENGTH = 4096

function findOscTerminator(data: string, startIndex: number): OscTerminator | null {
  const bel = data.indexOf('\x07', startIndex)
  const st = data.indexOf('\x1b\\', startIndex)

  if (bel === -1 && st === -1) {
    return null
  }
  if (bel !== -1 && (st === -1 || bel < st)) {
    return { index: bel, length: 1 }
  }
  return { index: st, length: 2 }
}

function parseBestEffortExitCode(value: string | undefined): number | null {
  if (!value) {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function findPrefixCarry(data: string): string {
  const maxCarryLength = Math.min(data.length, OSC_133_PREFIX.length - 1)
  for (let length = maxCarryLength; length > 0; length -= 1) {
    const suffix = data.slice(data.length - length)
    if (OSC_133_PREFIX.startsWith(suffix)) {
      return suffix
    }
  }
  return ''
}

export function createTerminalCommandLifecycle(options: TerminalCommandLifecycleOptions): {
  handlePtyData: (data: string) => void
  attachXtermConsumer: (terminal: Terminal) => IDisposable
  dispose: () => void
} {
  let carry = ''
  const disposables: IDisposable[] = []

  const handleOsc133 = (payload: string): void => {
    const [sequence, exitCode] = payload.split(';')
    if (sequence === 'D') {
      options.onCommandFinished(parseBestEffortExitCode(exitCode))
    }
  }

  const handlePtyData = (data: string): void => {
    let combined = carry + data
    carry = ''

    while (combined.length > 0) {
      const start = combined.indexOf(OSC_133_PREFIX)
      if (start === -1) {
        carry = findPrefixCarry(combined)
        return
      }

      const payloadStart = start + OSC_133_PREFIX.length
      const terminator = findOscTerminator(combined, payloadStart)
      if (!terminator) {
        carry = combined.slice(start)
        if (carry.length > MAX_OSC_CARRY_LENGTH) {
          carry = carry.slice(carry.length - MAX_OSC_CARRY_LENGTH)
        }
        return
      }

      handleOsc133(combined.slice(payloadStart, terminator.index))
      combined = combined.slice(terminator.index + terminator.length)
    }
  }

  return {
    handlePtyData,
    attachXtermConsumer(terminal) {
      const disposable = terminal.parser.registerOscHandler(133, () => true)
      disposables.push(disposable)
      return disposable
    },
    dispose() {
      carry = ''
      for (const disposable of disposables.splice(0)) {
        disposable.dispose()
      }
    }
  }
}
