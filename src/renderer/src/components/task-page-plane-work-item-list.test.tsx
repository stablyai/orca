// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PlaneWorkItem } from '../../../shared/plane-types'
import { TaskPagePlaneWorkItemList } from './task-page-plane-work-item-list'
import { TooltipProvider } from '@/components/ui/tooltip'

const item: PlaneWorkItem = {
  id: 'item-1',
  key: 'PROJ-123',
  sequenceId: 123,
  title: 'Polish Plane surface',
  url: 'https://app.plane.so/acme/browse/PROJ-123',
  project: { id: 'project-1', identifier: 'PROJ', name: 'Product' },
  state: { id: 'state-1', name: 'In Progress', group: 'started' },
  labels: [],
  assignees: [],
  priority: 'high',
  createdAt: '2026-08-18T12:00:00Z',
  updatedAt: '2026-08-19T12:00:00Z'
}

describe('TaskPagePlaneWorkItemList', () => {
  it('renders Plane identity and accessible actions', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <TaskPagePlaneWorkItemList items={[item]} onStartWorkspace={vi.fn()} />
      </TooltipProvider>
    )

    expect(markup).toContain('PROJ-123')
    expect(markup).toContain('Polish Plane surface')
    expect(markup).toContain('In Progress')
    expect(markup).toContain('Start workspace from PROJ-123')
    expect(markup).toContain('Open PROJ-123 in Plane')
  })
})
