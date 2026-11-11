import { describe, expect, it } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { getLocalWorkspacePortSections } from './local-workspace-port-sections'

const external = (
  port: number,
  extra: { pid?: number; hostManaged?: true } = {}
): WorkspacePort => ({
  id: `x:${port}`,
  kind: 'external',
  bindHost: '127.0.0.1',
  connectHost: 'localhost',
  port,
  protocol: 'http',
  pid: 'pid' in extra ? extra.pid : 100 + port,
  ...(extra.hostManaged ? { hostManaged: true } : {})
})

const scan = {
  ports: [
    external(6768, { hostManaged: true }),
    external(23456, { pid: undefined, hostManaged: true }),
    external(5432, { pid: undefined }),
    external(8123)
  ]
}

describe('getLocalWorkspacePortSections', () => {
  it('hides only host-marked services from External, keeping a pid-less user port', () => {
    const sections = getLocalWorkspacePortSections(scan, 'r', 'w', true)
    expect(sections.externalPorts.map((port) => port.port)).toEqual([5432, 8123])
  })

  it('keeps every listener on other hosts', () => {
    const sections = getLocalWorkspacePortSections(scan, 'r', 'w')
    expect(sections.externalPorts.map((port) => port.port)).toEqual([6768, 23456, 5432, 8123])
  })
})
