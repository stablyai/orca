import { describe, expect, it } from 'vitest'
import {
  isWslHostStoppedErrorLine,
  withoutWslHostStoppedLines,
  wslHostStoppedMessage
} from './wsl-host-stopped-message'

const IPC_WRAPPER = "Error invoking remote method 'runtimeEnvironments:call': Error: "

describe('the stopped WSL host refusal', () => {
  it('matches the line its own message produces, with or without the IPC wrapper', () => {
    const line = wslHostStoppedMessage('Ubuntu')
    expect(isWslHostStoppedErrorLine(line, 'Ubuntu')).toBe(true)
    expect(isWslHostStoppedErrorLine(`${IPC_WRAPPER}${line}`, 'Ubuntu')).toBe(true)
  })

  it.each(['', IPC_WRAPPER])(
    'keeps an unrelated line of a mixed error (wrapper: %j)',
    (wrapper) => {
      const error = `${wrapper}${wslHostStoppedMessage('Ubuntu')}\nPaste failed.`
      expect(withoutWslHostStoppedLines(error, 'Ubuntu')).toBe('Paste failed.')
    }
  )

  it('clears an error that was only the refusal', () => {
    expect(withoutWslHostStoppedLines(wslHostStoppedMessage('Ubuntu'), 'Ubuntu')).toBeNull()
  })

  it('keeps another, still-stopped distro’s refusal', () => {
    const other = wslHostStoppedMessage('Debian')
    expect(isWslHostStoppedErrorLine(other, 'Ubuntu')).toBe(false)
    expect(withoutWslHostStoppedLines(other, 'Ubuntu')).toBe(other)
  })
})
