// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import { LocalPortRow } from './local-port-row'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/lib/workspace-port-actions', () => ({
  getPortOpenBrowserTooltipLabel: (label: string) => label
}))

const workspacePort: WorkspacePort = {
  id: 'port',
  port: 4008,
  bindHost: '127.0.0.1',
  connectHost: 'localhost',
  protocol: 'http',
  kind: 'workspace',
  sourcePtyId: 'terminal',
  owner: {
    repoId: 'repo',
    worktreeId: 'workspace',
    displayName: 'Workspace',
    path: '/workspace',
    confidence: 'cwd'
  }
}

afterEach(cleanup)

function showMenu(port: WorkspacePort = workspacePort, onOpenLogs?: (port: WorkspacePort) => void) {
  render(
    <LocalPortRow port={port} onOpenLogs={onOpenLogs} onStop={vi.fn()} onShowDetails={vi.fn()} />
  )
  fireEvent.contextMenu(screen.getByLabelText('Port {{value0}} menu'))
}

describe('local port log actions', () => {
  it('omits log actions when the caller cannot open logs, even with a source terminal', () => {
    showMenu()
    expect(screen.queryByText('No source terminal available')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open Logs' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Show Details' })).toBeTruthy()
  })

  it('omits workspace log actions for external listeners', () => {
    showMenu(
      {
        id: 'external',
        port: 9097,
        bindHost: '127.0.0.1',
        connectHost: 'localhost',
        protocol: 'http',
        kind: 'external'
      },
      vi.fn()
    )
    expect(screen.queryByText('No source terminal available')).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Open Logs' })).toBeNull()
  })

  it('keeps a working log action when the caller supports source-terminal logs', () => {
    const onOpenLogs = vi.fn()
    showMenu(workspacePort, onOpenLogs)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Logs' }))
    expect(onOpenLogs).toHaveBeenCalledWith(workspacePort)
  })

  it('explains a missing source only when source-terminal logs are supported', () => {
    showMenu({ ...workspacePort, sourcePtyId: undefined }, vi.fn())
    expect(
      screen
        .getByRole('menuitem', { name: 'No source terminal available' })
        .getAttribute('aria-disabled')
    ).toBe('true')
  })
})
