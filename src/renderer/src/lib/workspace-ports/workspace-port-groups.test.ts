import { expect, it } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { getWorkspacePortGroups } from './workspace-port-groups'

it('normalizes missing owner names in the sorted port groups', () => {
  const port = (
    worktreeId: string,
    displayName: string,
    number: number
  ): Extract<WorkspacePort, { kind: 'workspace' }> => ({
    id: `${worktreeId}:${number}`,
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port: number,
    protocol: 'http',
    kind: 'workspace',
    owner: { worktreeId, repoId: 'repo', displayName, path: '/workspace', confidence: 'cwd' }
  })
  const unnamed = port('unnamed', '', 3001)
  Reflect.deleteProperty(unnamed.owner, 'displayName')
  const groups = getWorkspacePortGroups({
    platform: 'linux',
    scannedAt: 0,
    ports: [port('named', 'Beta', 3000), unnamed]
  })

  expect(groups.map(({ worktreeId, displayName }) => [worktreeId, displayName])).toEqual([
    ['unnamed', ''],
    ['named', 'Beta']
  ])
})
