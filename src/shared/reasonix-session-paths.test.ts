import { expect, it } from 'vitest'
import { isReasonixStorageSessionId, reasonixSessionLayout } from './reasonix-session-paths'

it.each([
  ['/home/test/.reasonix/projects/-work-tree/sessions-v4/id/events.frames', '/home/test/.reasonix'],
  [
    'C:\\Users\\test\\AppData\\Roaming\\reasonix\\projects\\c--work\\sessions-v4\\id\\events.frames',
    'C:\\Users\\test\\AppData\\Roaming\\reasonix'
  ],
  [
    '\\\\wsl.localhost\\Ubuntu\\home\\test\\.reasonix\\projects\\-work\\sessions-v4\\id\\events.frames',
    '\\\\wsl.localhost\\Ubuntu\\home\\test\\.reasonix'
  ],
  ['/projects/-work/sessions-v4/id/events.frames', '/'],
  ['C:\\projects\\c--work\\sessions-v4\\id\\events.frames', 'C:\\']
])('preserves the source host root for %s', (path, stateHome) => {
  expect(reasonixSessionLayout(path)).toMatchObject({ stateHome, sessionId: 'id' })
})

it.each([
  'relative/projects/p/sessions-v4/id/events.frames',
  '/home/../outside/projects/p/sessions-v4/id/events.frames',
  '/home/p/projects/../sessions-v4/id/events.frames',
  '/home/p/projects/x/sessions-v4/../events.frames',
  '/home/p/projects/x/sessions-v4/id/manifest.json'
])('refuses paths outside the canonical CLI log shape: %s', (path) => {
  expect(reasonixSessionLayout(path)).toBeNull()
})

it.each([
  '..',
  '.hidden',
  'trailing.',
  'CON',
  'nul.txt',
  'COM1',
  'LPT9.log',
  'id/child',
  'id\\child',
  'id:stream',
  'line\nbreak',
  ' leading',
  'x'.repeat(256)
])('refuses the native invalid session id %s', (id) => {
  expect(isReasonixStorageSessionId(id)).toBe(false)
})

it('accepts native Unicode identities by UTF-8 byte budget', () => {
  expect(isReasonixStorageSessionId('会話'.repeat(42))).toBe(true)
  expect(isReasonixStorageSessionId('会話'.repeat(43))).toBe(false)
})
