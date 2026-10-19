import { expect, it } from 'vitest'
import { describeFileExplorerReadError } from './file-explorer-read-error'

it('drops the IPC wrapper a runtime-host read error arrives with', () => {
  expect(
    describeFileExplorerReadError(
      new Error(
        "Error invoking remote method 'runtimeEnvironments:call': Error: WSL hosts are turned off in Settings → Experimental."
      )
    )
  ).toBe('WSL hosts are turned off in Settings → Experimental.')
})

it('keeps an empty message empty so the read still reads as failed', () => {
  const empty = new Error('replaced below')
  empty.message = ''
  expect(describeFileExplorerReadError(empty)).toBe('')
})

it('keeps a plain error and a non-Error rejection as-is', () => {
  expect(describeFileExplorerReadError(new Error('Permission denied'))).toBe('Permission denied')
  expect(describeFileExplorerReadError('EACCES')).toBe('EACCES')
})
