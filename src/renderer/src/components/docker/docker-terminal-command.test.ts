import { describe, expect, it } from 'vitest'
import { buildDockerTerminalCommand } from './docker-terminal-command'
import type { DockerConnection } from '../../../../shared/docker-types'

const LOCAL: DockerConnection = { id: 'local', label: 'Local', kind: 'local' }
const TCP: DockerConnection = {
  id: 't',
  label: 'CI',
  kind: 'tcp',
  tcp: { host: '10.0.0.5', port: 2376 }
}
const SSH: DockerConnection = { id: 's', label: 'Box', kind: 'ssh', sshTargetId: 'target-1' }

describe('buildDockerTerminalCommand', () => {
  it('builds a local logs command with a null connectionId', () => {
    expect(buildDockerTerminalCommand(LOCAL, 'logs', 'abc')).toEqual({
      command: 'clear && docker logs -f --tail 1000 abc',
      connectionId: null
    })
  })

  it('builds a local shell command', () => {
    expect(buildDockerTerminalCommand(LOCAL, 'shell', 'abc')).toEqual({
      command: 'clear && docker exec -it abc sh',
      connectionId: null
    })
  })

  it('adds -H for tcp connections, still local transport', () => {
    expect(buildDockerTerminalCommand(TCP, 'logs', 'abc')).toEqual({
      command: 'clear && docker -H tcp://10.0.0.5:2376 logs -f --tail 1000 abc',
      connectionId: null
    })
  })

  it('routes ssh connections through the relay via the sshTargetId', () => {
    expect(buildDockerTerminalCommand(SSH, 'shell', 'abc')).toEqual({
      command: 'clear && docker exec -it abc sh',
      connectionId: 'target-1'
    })
  })

  it('uses cls for local/tcp terminals on Windows (cmd.exe rejects clear)', () => {
    expect(buildDockerTerminalCommand(LOCAL, 'logs', 'abc', 'docker', 'win32')).toEqual({
      command: 'cls && docker logs -f --tail 1000 abc',
      connectionId: null
    })
  })

  it('keeps clear for ssh terminals even on a Windows client (remote is POSIX)', () => {
    expect(buildDockerTerminalCommand(SSH, 'shell', 'abc', 'docker', 'win32')).toEqual({
      command: 'clear && docker exec -it abc sh',
      connectionId: 'target-1'
    })
  })

  it('adds --tlsverify for tls-enabled tcp connections', () => {
    const tcpTls: DockerConnection = {
      id: 't',
      label: 'CI',
      kind: 'tcp',
      tcp: { host: '10.0.0.5', port: 2376, tls: true }
    }
    expect(buildDockerTerminalCommand(tcpTls, 'logs', 'abc')).toEqual({
      command: 'clear && docker -H tcp://10.0.0.5:2376 --tlsverify logs -f --tail 1000 abc',
      connectionId: null
    })
  })

  it('throws for a tcp connection missing host/port configuration', () => {
    expect(() =>
      buildDockerTerminalCommand(
        { id: 't', label: 'CI', kind: 'tcp' } as DockerConnection,
        'logs',
        'abc'
      )
    ).toThrow('TCP Docker connection is missing host/port configuration')
  })
})
