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
    external(23456, { pid: undefined }),
    external(5432)
  ]
}

describe('getLocalWorkspacePortSections', () => {
  it('hides a sandbox host’s own services and pid-less root listeners from External', () => {
    const sections = getLocalWorkspacePortSections(scan, 'r', 'w', true)
    expect(sections.externalPorts.map((port) => port.port)).toEqual([5432])
  })

  it('keeps every listener on other hosts', () => {
    const sections = getLocalWorkspacePortSections(scan, 'r', 'w')
    expect(sections.externalPorts.map((port) => port.port)).toEqual([6768, 23456, 5432])
  })
})
