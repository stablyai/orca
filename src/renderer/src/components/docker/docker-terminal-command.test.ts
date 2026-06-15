import { describe, expect, it } from 'vitest'
import { buildDockerTerminalCommand } from './docker-terminal-command'
import type { DockerConnection } from '../../../../shared/docker-types'

const LOCAL: DockerConnection = { id: 'local', label: 'Local', kind: 'local' }
const TCP: DockerConnection = { id: 't', label: 'CI', kind: 'tcp', tcp: { host: '10.0.0.5', port: 2376 } }
const SSH: DockerConnection = { id: 's', label: 'Box', kind: 'ssh', sshTargetId: 'target-1' }

describe('buildDockerTerminalCommand', () => {
  it('builds a local logs command with a null connectionId', () => {
    expect(buildDockerTerminalCommand(LOCAL, 'logs', 'abc')).toEqual({
      command: 'docker logs -f --tail 1000 abc',
      connectionId: null
    })
  })

  it('builds a local shell command', () => {
    expect(buildDockerTerminalCommand(LOCAL, 'shell', 'abc')).toEqual({
      command: 'docker exec -it abc sh',
      connectionId: null
    })
  })

  it('adds -H for tcp connections, still local transport', () => {
    expect(buildDockerTerminalCommand(TCP, 'logs', 'abc')).toEqual({
      command: 'docker -H tcp://10.0.0.5:2376 logs -f --tail 1000 abc',
      connectionId: null
    })
  })

  it('routes ssh connections through the relay via the sshTargetId', () => {
    expect(buildDockerTerminalCommand(SSH, 'shell', 'abc')).toEqual({
      command: 'docker exec -it abc sh',
      connectionId: 'target-1'
    })
  })
})
