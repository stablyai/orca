import { describe, expect, it } from 'vitest'
import { buildDockerConnectionList } from './docker'
import { LOCAL_DOCKER_CONNECTION_ID } from '../../../../shared/docker-types'

describe('buildDockerConnectionList', () => {
  it('always starts with the built-in local connection', () => {
    expect(buildDockerConnectionList(null)[0].id).toBe(LOCAL_DOCKER_CONNECTION_ID)
  })

  it('appends user connections after local and de-dupes a stray "local"', () => {
    const list = buildDockerConnectionList([
      { id: 'local', label: 'Bogus', kind: 'local' },
      { id: 'box', label: 'Box', kind: 'ssh', sshTargetId: 't1' }
    ])
    expect(list.map((c) => c.id)).toEqual([LOCAL_DOCKER_CONNECTION_ID, 'box'])
  })
})
