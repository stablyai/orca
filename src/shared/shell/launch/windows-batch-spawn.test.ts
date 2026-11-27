import { afterEach, expect, it, vi } from 'vitest'
import { getCmdExePath } from './windows-batch-spawn'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('falls back past blank ComSpec and blank SystemRoot to an absolute cmd.exe path', () => {
  vi.stubEnv('ComSpec', '   ')
  vi.stubEnv('COMSPEC', '')
  vi.stubEnv('SystemRoot', '')
  vi.stubEnv('SYSTEMROOT', '')
  vi.stubEnv('windir', '')
  vi.stubEnv('WINDIR', ' D:\\Windows ')

  expect(getCmdExePath()).toBe('D:\\Windows\\System32\\cmd.exe')

  vi.stubEnv('WINDIR', '')
  expect(getCmdExePath()).toBe('C:\\Windows\\System32\\cmd.exe')

  vi.stubEnv('COMSPEC', ' E:\\Windows\\System32\\cmd.exe ')
  expect(getCmdExePath()).toBe('E:\\Windows\\System32\\cmd.exe')
})
