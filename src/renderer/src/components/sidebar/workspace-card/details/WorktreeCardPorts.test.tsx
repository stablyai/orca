// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { WorkspacePort } from '../../../../../../shared/workspace-ports'
import { WorktreeCardPortsTrigger } from './WorktreeCardPorts'

afterEach(cleanup)

const port: WorkspacePort = {
  id: '127.0.0.1:5173',
  bindHost: '127.0.0.1',
  connectHost: '127.0.0.1',
  port: 5173,
  pid: 1234,
  processName: 'node',
  protocol: 'unknown',
  kind: 'external'
}

describe('WorktreeCardPortsTrigger', () => {
  it('names the workspace link when no port is live', () => {
    render(
      <WorktreeCardPortsTrigger
        ports={[]}
        worktree={{ id: 'wt', workspaceUrl: 'https://app.test' }}
      />
    )
    expect(screen.getByRole('button', { name: 'Workspace link' })).toBeTruthy()
  })

  it('counts live ports when there are any', () => {
    render(<WorktreeCardPortsTrigger ports={[port]} />)
    expect(screen.getByRole('button', { name: '1 live port' })).toBeTruthy()
  })
})
