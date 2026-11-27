import { afterEach, expect, it, vi } from 'vitest'
import { processEnvWithoutAgentSession } from './parent-agent-session-env'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('drops a forge credential however Windows spells its name', () => {
  vi.stubEnv('orca_azure_devops_pat', 'inherited-pat')

  expect(processEnvWithoutAgentSession('win32').orca_azure_devops_pat).toBeUndefined()
  expect(processEnvWithoutAgentSession('linux').orca_azure_devops_pat).toBe('inherited-pat')
})
