// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'

const { readAnnotation, readContent, readDiff } = vi.hoisted(() => ({
  readAnnotation: vi.fn(),
  readContent: vi.fn(),
  readDiff: vi.fn()
}))
vi.mock('@/runtime/runtime-maestro-workspace-client', () => ({
  readRuntimeMaestroAnnotation: readAnnotation,
  readRuntimeMaestroContent: readContent,
  readRuntimeMaestroDiff: readDiff
}))

import { MaestroWorkspaceContentPreview } from './MaestroWorkspaceContentPreview'

function surface(
  tone: 'decision' | 'warning' | 'blocked' | 'observation' | null
): WorkspaceSurface {
  return {
    id: {
      execution_host_id: 'local',
      workspace_key: 'folder:workspace-1',
      unified_tab_id: 'tab-1'
    },
    content_type: 'editor',
    entity_id: 'file-1',
    group_id: 'group-1',
    title: 'Note',
    revision: 1,
    availability: 'available',
    binding: {
      kind: 'content',
      entity_id: 'file-1',
      content_type: 'editor',
      model_revision: 'model-1',
      owner_principal: 'runtime-session',
      read_only: false,
      source: {
        relative_path: 'note.md',
        language: 'markdown',
        mode: 'edit',
        diff_source: null,
        is_dirty: false
      },
      annotation: tone ? { relative_path: 'note.md', tone } : null
    }
  }
}

describe('MaestroWorkspaceContentPreview', () => {
  afterEach(cleanup)
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { setMarkdownEditorFocused: vi.fn() } }
    })
    readAnnotation
      .mockReset()
      .mockResolvedValue({ content: '# New annotation', version: '1', source: 'file' })
    readContent
      .mockReset()
      .mockResolvedValue({ content: 'Exact file', modelRevision: 'model-1', tabId: 'tab-1' })
  })

  it('reads a non-annotation editor through the exact Canvas content authority', async () => {
    render(<MaestroWorkspaceContentPreview target={{ kind: 'local' }} surface={surface(null)} />)
    expect(await screen.findByText('Exact file')).not.toBeNull()
    expect(readContent).toHaveBeenCalledWith(
      { kind: 'local' },
      { execution_host_id: 'local', workspace_key: 'folder:workspace-1' },
      surface(null).id
    )
  })

  it('keeps the resolved preview when a layout mutation rebuilds equivalent objects', async () => {
    const view = render(
      <MaestroWorkspaceContentPreview target={{ kind: 'local' }} surface={surface(null)} />
    )
    expect(await screen.findByText('Exact file')).not.toBeNull()
    readContent.mockClear()
    view.rerender(
      <MaestroWorkspaceContentPreview target={{ kind: 'local' }} surface={surface(null)} />
    )
    expect(screen.getByText('Exact file')).not.toBeNull()
    expect(screen.queryByText('Loading exact content…')).toBeNull()
    expect(readContent).not.toHaveBeenCalled()
  })

  it('reads again only when the content identity changes after resolution', async () => {
    const view = render(
      <MaestroWorkspaceContentPreview target={{ kind: 'local' }} surface={surface(null)} />
    )
    expect(await screen.findByText('Exact file')).not.toBeNull()
    readContent.mockClear()
    view.rerender(
      <MaestroWorkspaceContentPreview
        target={{ kind: 'local' }}
        surface={{
          ...surface(null),
          id: { ...surface(null).id, unified_tab_id: 'tab-2' }
        }}
      />
    )
    await screen.findByText('Exact file')
    expect(readContent).toHaveBeenCalledTimes(1)
    expect(readContent.mock.calls[0][2]).toMatchObject({ unified_tab_id: 'tab-2' })
  })

  it('renders an annotation as a neutral mini editor without tone controls', async () => {
    render(
      <MaestroWorkspaceContentPreview
        target={{ kind: 'local' }}
        surface={surface('observation')}
        onUpdateAnnotationContent={vi.fn()}
      />
    )

    expect(await screen.findByRole('button', { name: 'Bold' })).not.toBeNull()
    expect(screen.queryByLabelText('Annotation color')).toBeNull()
    expect(document.querySelector('[data-annotation-tone]')).toBeNull()
  })
})
