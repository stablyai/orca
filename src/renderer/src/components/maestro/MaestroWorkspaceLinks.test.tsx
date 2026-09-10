// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceCanvasDocument } from '../../../../shared/maestro-document-contract'
import type { WorkspaceSurfaceSnapshot } from '../../../../shared/maestro-workspace-canvas'
import {
  MaestroWorkspaceLinks,
  unconfirmedOptimisticMaestroManualLinks
} from './MaestroWorkspaceLinks'
import type { CanvasAgentTopology } from './maestro-agent-topology'

const document: WorkspaceCanvasDocument = {
  schema_version: 1,
  last_surface_revision: 0,
  placements: {},
  annotations: {},
  manual_links: [],
  suggestion_decisions: {},
  ui_preferences: { inspector_open: false, inspector_width: 320 }
}

const snapshot: WorkspaceSurfaceSnapshot = {
  schema_version: 1,
  protocol: 'workspace-surface-snapshot/v1',
  execution_host_id: 'local',
  workspace_key: 'folder:workspace',
  authority_revision: 1,
  authority_cursor: 'cursor-1',
  state: 'ready',
  surfaces: {},
  unsupported: [],
  automatic_links: [
    {
      id: 'automatic-parent',
      source_surface_key: 'worker',
      target_surface_key: 'coordinator',
      link_type: 'parent-child',
      authority_kind: 'parent-child-receipt',
      authority_id: 'run:edge',
      authority_revision: 1,
      observed_at: '2026-08-27T12:00:00.000Z',
      explanation_code: 'parent-child'
    }
  ],
  suggested_links: [],
  capability: { available: true, reason: null },
  harness_overlay: null
}

const topology: CanvasAgentTopology = {
  coordinatorSurfaceId: 'coordinator',
  nodes: [],
  relations: [
    {
      id: 'delegate',
      sourceSurfaceId: 'coordinator',
      targetSurfaceId: 'worker',
      kind: 'delegates',
      provenance: 'orca-orchestration'
    }
  ]
}

const placements = {
  coordinator: {
    position: { x: 0, y: 0 },
    size: { width: 760, height: 530 },
    collapsed: false,
    z_order: 1
  },
  worker: {
    position: { x: 900, y: 0 },
    size: { width: 760, height: 530 },
    collapsed: false,
    z_order: 2
  }
}

const manualDocument: WorkspaceCanvasDocument = {
  ...document,
  manual_links: [
    {
      id: 'manual-1',
      source_surface_key: 'worker',
      target_surface_key: 'coordinator',
      link_type: 'context-for',
      label: null,
      author_id: 'user-1',
      created_at: '2026-08-27T12:00:00.000Z',
      revision: 1
    }
  ]
}

const duplicatedManualDocument: WorkspaceCanvasDocument = {
  ...manualDocument,
  manual_links: [
    ...manualDocument.manual_links,
    {
      ...manualDocument.manual_links[0]!,
      id: 'manual-2',
      source_surface_key: 'coordinator',
      target_surface_key: 'worker',
      created_at: '2026-08-27T12:01:00.000Z',
      revision: 2
    }
  ]
}

describe('MaestroWorkspaceLinks', () => {
  afterEach(cleanup)

  it('deduplicates a reversed automatic parent link from its delegate relation', () => {
    const view = render(
      <MaestroWorkspaceLinks
        snapshot={snapshot}
        document={document}
        topology={topology}
        placements={placements}
      />
    )

    expect(view.container.querySelectorAll('[data-link-kind="delegates"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-link-kind="automatic"]')).toHaveLength(0)
  })

  it('renders one manual projection when topology shares the same endpoints', () => {
    const view = render(
      <MaestroWorkspaceLinks
        snapshot={snapshot}
        document={manualDocument}
        topology={topology}
        placements={placements}
        onManualLinkSelect={vi.fn()}
        onManualLinkDelete={vi.fn()}
      />
    )

    expect(view.container.querySelectorAll('[data-link-kind="manual"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('[data-link-kind="delegates"]')).toHaveLength(0)
    expect(view.container.querySelectorAll('[data-link-kind="automatic"]')).toHaveLength(0)
    expect(view.container.querySelectorAll('text')).toHaveLength(1)
  })

  it('renders one selectable manual link for reversed duplicate records', () => {
    const onManualLinkSelect = vi.fn()
    const onManualLinkDelete = vi.fn()
    const view = render(
      <MaestroWorkspaceLinks
        snapshot={{ ...snapshot, automatic_links: [] }}
        document={duplicatedManualDocument}
        topology={{ ...topology, relations: [] }}
        placements={placements}
        selectedManualLinkId="manual-1"
        onManualLinkSelect={onManualLinkSelect}
        onManualLinkDelete={onManualLinkDelete}
      />
    )

    const link = screen.getByRole('button', {
      name: 'Manual link from worker to coordinator'
    })
    expect(view.container.querySelectorAll('[data-link-kind="manual"]')).toHaveLength(1)
    expect(view.container.querySelectorAll('rect')).toHaveLength(1)
    expect(view.container.querySelectorAll('text')).toHaveLength(1)
    expect(link.getAttribute('data-maestro-manual-link')).toBe('manual-1')
    expect(link.getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(link)
    fireEvent.keyDown(link, { key: 'Delete' })

    expect(onManualLinkSelect).toHaveBeenCalledWith('manual-1')
    expect(onManualLinkDelete).toHaveBeenCalledWith('manual-1')
  })

  it('clears a reversed optimistic link after its confirmed pair arrives', () => {
    expect(
      unconfirmedOptimisticMaestroManualLinks(
        [{ id: 'optimistic-1', source: 'coordinator', target: 'worker' }],
        manualDocument.manual_links
      )
    ).toEqual([])
  })

  it.each(['Delete', 'Backspace'])('deletes a selected manual link with %s', (key) => {
    const onManualLinkSelect = vi.fn()
    const onManualLinkDelete = vi.fn()
    const view = render(
      <MaestroWorkspaceLinks
        snapshot={{ ...snapshot, automatic_links: [] }}
        document={manualDocument}
        topology={{ ...topology, relations: [] }}
        placements={placements}
        selectedManualLinkId="manual-1"
        onManualLinkSelect={onManualLinkSelect}
        onManualLinkDelete={onManualLinkDelete}
      />
    )

    const link = screen.getByRole('button', {
      name: 'Manual link from worker to coordinator'
    })
    expect(link.getAttribute('aria-pressed')).toBe('true')
    expect(link.getAttribute('data-link-selected')).toBe('true')
    expect(view.container.querySelectorAll('path')).toHaveLength(3)

    fireEvent.keyDown(link, { key })

    expect(onManualLinkDelete).toHaveBeenCalledOnce()
    expect(onManualLinkDelete).toHaveBeenCalledWith('manual-1')
  })

  it('selects a manual link and removes it from its context menu', async () => {
    const onManualLinkSelect = vi.fn()
    const onManualLinkDelete = vi.fn()
    render(
      <MaestroWorkspaceLinks
        snapshot={{ ...snapshot, automatic_links: [] }}
        document={manualDocument}
        topology={{ ...topology, relations: [] }}
        placements={placements}
        onManualLinkSelect={onManualLinkSelect}
        onManualLinkDelete={onManualLinkDelete}
      />
    )

    const link = screen.getByRole('button', {
      name: 'Manual link from worker to coordinator'
    })
    const hitPath = link.querySelector('path')
    expect(hitPath?.getAttribute('stroke-width')).toBe('28')
    expect(hitPath?.getAttribute('pointer-events')).toBe('stroke')
    fireEvent.click(link)
    expect(onManualLinkSelect).toHaveBeenCalledWith('manual-1')

    fireEvent.contextMenu(link)
    fireEvent.click(await screen.findByText('Remove link'))

    expect(onManualLinkDelete).toHaveBeenCalledWith('manual-1')
  })

  it('keeps automatic and topology links read-only', () => {
    const view = render(
      <MaestroWorkspaceLinks
        snapshot={snapshot}
        document={document}
        topology={topology}
        placements={placements}
        onManualLinkSelect={vi.fn()}
        onManualLinkDelete={vi.fn()}
      />
    )

    expect(screen.queryByRole('button')).toBeNull()
    expect(
      view.container.querySelector('[data-link-kind="delegates"]')?.getAttribute('aria-hidden')
    ).toBe('true')
  })
})
