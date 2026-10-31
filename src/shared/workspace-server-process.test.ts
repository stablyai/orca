import { describe, expect, it } from 'vitest'
import {
  serverLogLevel,
  trimServerLogs,
  type WorkspaceServerLogLine
} from './workspace-server-process'

describe('server error classification', () => {
  it.each([
    'ERROR failed to bind',
    '[ERROR] connection refused',
    '2026-10-26 ERROR app failed',
    'Error: EADDRINUSE',
    'java.lang.IllegalStateException: bad state',
    'Exception in thread "main"',
    '{"level":"error","msg":"failed"}'
  ])('recognizes explicit errors: %s', (line) => expect(serverLogLevel(line)).toBe('error'))
  it.each([
    'INFO health check ready',
    'compiled successfully, 0 errors',
    'INFO error handler registered',
    'request completed'
  ])('does not confuse ordinary stderr or normal text with errors: %s', (line) =>
    expect(serverLogLevel(line)).toBe('info')
  )
  it('keeps warnings separate', () =>
    expect(serverLogLevel('WARN experimental feature')).toBe('warning'))
})
it('retains only a bounded recent log tail', () => {
  const lines: WorkspaceServerLogLine[] = Array.from({ length: 1000 }, (_, seq) => ({
    seq,
    time: 0,
    source: 'stdout',
    level: 'info',
    text: 'x'.repeat(1000)
  }))
  const retained = trimServerLogs(lines)
  expect(retained.length).toBeLessThanOrEqual(500)
  expect(retained.reduce((sum, line) => sum + line.text.length, 0)).toBeLessThanOrEqual(65536)
  expect(retained.at(-1)?.seq).toBe(999)
})
