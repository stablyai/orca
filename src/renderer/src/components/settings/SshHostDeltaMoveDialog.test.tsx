// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  OrcadDeltaMovePreview,
  OrcadDeltaMoveResult
} from '../../../../shared/orcad-managed-runtime'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { SshHostDeltaMoveDialog } from './SshHostDeltaMoveDialog'

vi.mock('../ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

const roots: Root[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

const target: SshTarget = { id: 'ssh-1', label: 'Builder', host: 'b', port: 22, username: 'dev' }

function preview(overrides: Partial<OrcadDeltaMovePreview> = {}): OrcadDeltaMovePreview {
  return {
    sshTargetId: 'ssh-1',
    environmentId: 'env-1',
    added: [{ kind: 'repository', id: 'repo-2', label: 'tool' }],
    notReflected: {
      edited: [{ kind: 'repository', id: 'repo-1', label: 'app' }],
      removed: [{ kind: 'folder-workspace', id: 'f-1', label: 'notes' }]
    },
    blockers: [],
    ...overrides
  }
}

function api(next: OrcadDeltaMovePreview, result: OrcadDeltaMoveResult): ManagedOrcadPreloadApi {
  const unused = vi.fn(async () => {
    throw new Error('not used by the delta dialog')
  })
  return {
    deploy: unused,
    getStatus: unused,
    update: unused,
    rollback: unused,
    recover: unused,
    stop: unused,
    cancelStop: unused,
    linkSshAccess: unused,
    unlinkSshAccess: unused,
    convertSshHost: unused,
    listPendingMigrations: unused,
    previewDeltaMove: vi.fn(async () => next),
    moveDelta: vi.fn(async () => result),
    keepServerVersion: unused
  }
}

async function render(
  managed: ManagedOrcadPreloadApi,
  onFinished = vi.fn()
): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      <SshHostDeltaMoveDialog
        api={managed}
        target={target}
        onClose={vi.fn()}
        onFinished={onFinished}
      />
    )
  })
  return container
}

function confirmButton(container: HTMLElement): HTMLButtonElement {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent === 'Move the new projects'
  )!
}

describe('moving what an older build added', () => {
  it('lists what is added and what the server will not reflect, then moves', async () => {
    const onFinished = vi.fn()
    const managed = api(preview(), { outcome: 'moved', migrationId: 'm-2' })
    const container = await render(managed, onFinished)
    expect(container.textContent).toContain('Repository tool')
    expect(container.textContent).toContain('the server keeps its own copy')
    expect(container.textContent).toContain('Repository app')
    expect(container.textContent).toContain('Folder notes')
    await act(async () => confirmButton(container).click())
    expect(managed.moveDelta).toHaveBeenCalledWith({ sshTargetId: 'ssh-1' })
    expect(onFinished).toHaveBeenCalled()
  })

  it('shows a refusal plainly and keeps the dialog open', async () => {
    const managed = api(preview(), {
      outcome: 'refused',
      code: 'orcad_delta_refused_by_server',
      reason: 'orcad_migration_repository_id_conflict:repo-2'
    })
    const container = await render(managed)
    await act(async () => confirmButton(container).click())
    expect(container.textContent).toContain('Orca couldn’t finish this on the server.')
    expect(container.textContent).not.toContain('orcad_')
  })

  it('keeps a running move when the caller passes a fresh target object', async () => {
    const managed = api(preview(), { outcome: 'moved', migrationId: 'm-2' })
    managed.moveDelta = vi.fn(() => new Promise<OrcadDeltaMoveResult>(() => {}))
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    roots.push(root)
    const renderWith = (next: SshTarget) =>
      act(async () => {
        root.render(
          <SshHostDeltaMoveDialog
            api={managed}
            target={next}
            onClose={vi.fn()}
            onFinished={vi.fn()}
          />
        )
      })
    await renderWith(target)
    await act(async () => confirmButton(container).click())
    await renderWith({ ...target })
    expect(managed.previewDeltaMove).toHaveBeenCalledTimes(1)
    expect(confirmButton(container).disabled).toBe(true)
  })

  it('does not offer the move when nothing is new', async () => {
    const container = await render(
      api(preview({ added: [] }), { outcome: 'moved', migrationId: 'm' })
    )
    expect(container.textContent).toContain('Nothing new to add.')
    expect(confirmButton(container).disabled).toBe(true)
  })
})
