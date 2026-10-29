// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { workspacePortRuntimeTargetKey } from '@/lib/workspace-port-actions'
import PortsPanel from './PortsPanel'

const initialState = useAppStore.getInitialState()

const folderWorkspace: FolderWorkspace = {
  id: 'f1',
  projectGroupId: 'g1',
  name: 'notes',
  folderPath: '/home/me/notes',
  connectionId: null,
  executionHostId: 'runtime:env-a',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 0,
  updatedAt: 0
}

const scan: WorkspacePortScanResult = {
  platform: 'linux',
  scannedAt: 1,
  ports: [
    {
      id: '127.0.0.1:5173:42',
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1',
      port: 5173,
      pid: 42,
      processName: 'vite',
      protocol: 'http',
      kind: 'external'
    }
  ]
}

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

describe('Ports panel for a folder workspace on a managed SSH server', () => {
  it('shows the SSH forwards and the server listeners, not "No workspace selected"', () => {
    const scanKey = `${workspacePortRuntimeTargetKey({ kind: 'environment', environmentId: 'env-a' })}:all`
    useAppStore.setState({
      folderWorkspaces: [folderWorkspace],
      activeWorktreeId: 'folder:f1',
      activeWorkspaceExecutionHostId: 'runtime:env-a',
      runtimeEnvironments: [
        {
          id: 'env-a',
          name: 'Box',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          preferredEndpointId: 'ep',
          endpoints: [],
          orcadDeployment: {
            sshTargetId: 'box',
            sshTargetGeneration: 1,
            localPort: 7001,
            remotePort: 7002
          }
        }
      ],
      sshConnectionStates: new Map([
        ['box', { targetId: 'box', status: 'connected', error: null, reconnectAttempt: 0 }]
      ]),
      workspacePortScansByKey: { [scanKey]: scan }
    })
    render(
      <TooltipProvider>
        <PortsPanel isVisible />
      </TooltipProvider>
    )
    expect(screen.queryByText('No workspace selected')).toBeNull()
    expect(screen.getByRole('button', { name: /Add/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /External\s*1/ })).toBeTruthy()
  })
})
