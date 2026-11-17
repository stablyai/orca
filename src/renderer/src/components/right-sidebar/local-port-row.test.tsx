// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace/ports/workspace-ports'
import { LocalPortRow } from './ports/local-port-row'
import { SharePortButton, SharePortMenuItem } from './cloud-share/use-share-port-action'

const port: WorkspacePort = {
  id: '127.0.0.1:3000:4242',
  bindHost: '127.0.0.1',
  connectHost: '127.0.0.1',
  port: 3000,
  pid: 4242,
  processName: 'vite',
  protocol: 'http',
  kind: 'workspace',
  owner: {
    worktreeId: 'repo::/workspace/app',
    repoId: 'repo',
    displayName: 'app',
    path: '/workspace/app',
    confidence: 'cwd'
  }
}

function renderRow(openShareDialog = vi.fn(), available = true) {
  const action = { available, openShareDialog }
  render(
    <LocalPortRow
      port={port}
      onStop={vi.fn()}
      onShowDetails={vi.fn()}
      onOpenInBrowser={vi.fn()}
      shareAction={<SharePortButton port={port.port} action={action} />}
      forwardMenuItems={<SharePortMenuItem port={port.port} action={action} />}
    />
  )
  return openShareDialog
}

afterEach(cleanup)

describe('LocalPortRow keyboard actions', () => {
  it('offers Open in browser, Share… and More actions as row buttons', () => {
    const openShareDialog = renderRow()
    expect(screen.getByRole('button', { name: 'Open in browser' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Share port 3000…' }))
    expect(openShareDialog).toHaveBeenCalledWith(3000)
    expect(screen.getByRole('button', { name: 'More actions for port 3000' })).toBeTruthy()
  })

  it('hides Share… when sharing is unavailable', () => {
    renderRow(vi.fn(), false)
    expect(screen.queryByRole('button', { name: 'Share port 3000…' })).toBeNull()
  })

  it('opens the row menu, Share… included, from the More actions button', async () => {
    const openShareDialog = renderRow()
    fireEvent.click(screen.getByRole('button', { name: 'More actions for port 3000' }))
    const share = await screen.findByRole('menuitem', { name: 'Share…' })
    expect(screen.getByRole('menuitem', { name: 'Copy address' })).toBeTruthy()
    fireEvent.click(share)
    expect(openShareDialog).toHaveBeenCalledWith(3000)
  })

  it('keeps the focus-ring outline on the row group', () => {
    renderRow()
    const group = screen.getByRole('group', { name: 'Port 3000 menu' })
    expect(group.className).not.toContain('focus:outline-none')
    expect(group.className).toContain('focus-visible:outline-focus-ring')
  })
})
