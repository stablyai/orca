import { describe, expect, it } from 'vitest'
import { parseRuntimeHostSshRoute } from './RuntimeHostAccessForm'

describe('parseRuntimeHostSshRoute', () => {
  it('maps the form fields to the SSH access link request fields', () => {
    expect(parseRuntimeHostSshRoute('ssh-1', ' 6768 ')).toEqual({
      sshTargetId: 'ssh-1',
      remotePort: 6768
    })
  })

  it('rejects a missing host or an out-of-range port', () => {
    expect(parseRuntimeHostSshRoute('', '6768')).toBeNull()
    expect(parseRuntimeHostSshRoute('ssh-1', '0')).toBeNull()
    expect(parseRuntimeHostSshRoute('ssh-1', '65536')).toBeNull()
    expect(parseRuntimeHostSshRoute('ssh-1', '22.5')).toBeNull()
  })
})
