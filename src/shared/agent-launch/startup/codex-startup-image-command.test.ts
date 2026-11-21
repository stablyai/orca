import { expect, it } from 'vitest'
import {
  unwrapCodexStartupImageCommand,
  withCodexStartupImageCommand
} from './codex-startup-image-command'

const quotedPath = `"C:\\Program Files\\Codex CLI\\bin\\codex.exe" --no-daemon resume 'id'`

it.each([
  [quotedPath, `& ${quotedPath}`],
  [`'C:\\Program Files\\codex.exe' --no-daemon`, `& 'C:\\Program Files\\codex.exe' --no-daemon`],
  [`& ${quotedPath}`, `& ${quotedPath}`],
  ['codex.exe --no-daemon', 'codex.exe --no-daemon'],
  ['C:\\tools\\codex.exe --no-daemon', 'C:\\tools\\codex.exe --no-daemon'],
  ['$env:LOCALAPPDATA\\codex.exe --no-daemon', '$env:LOCALAPPDATA\\codex.exe --no-daemon']
])('wraps %s for PowerShell as %s', (command, call) => {
  const wrapped = withCodexStartupImageCommand(command, 'powershell')
  expect(wrapped).not.toBe(command)
  expect(unwrapCodexStartupImageCommand(wrapped)).toBe(call)
})
