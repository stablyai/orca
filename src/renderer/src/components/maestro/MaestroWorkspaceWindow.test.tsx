// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/components/dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId, mode }: { ptyId: string; mode: string }) => (
    <input
      aria-label="Exact terminal input"
      data-terminal-preview={ptyId}
      data-terminal-preview-mode={mode}
    />
  )
}))
vi.mock('./MaestroWorkspaceBrowserPreview', () => ({
  MaestroWorkspaceBrowserPreview: ({ pageId }: { pageId: string }) => (
    <img data-browser-preview={pageId} />
  )
}))

import { MaestroWorkspaceWindow } from './MaestroWorkspaceWindow'
import { resolveMaestroWorkspaceSurfaceTitle } from './maestro-workspace-surface-title'

const scope = { execution_host_id: 'local', workspace_key: 'folder:workspace-1' }
const placement = {
  position: { x: 0, y: 0 },
  size: { width: 320, height: 220 },
  collapsed: false,
  z_order: 0
}
const callbacks = {
  onSelect: vi.fn(),
  onRename: vi.fn(),
  onLinkPointerDown: vi.fn(),
  onFocus: vi.fn(),
  onClose: vi.fn(),
  onMoveCommit: vi.fn(),
  onResizeCommit: vi.fn()
}

function terminal(): WorkspaceSurface {
  return {
    id: { ...scope, unified_tab_id: 'tab-1' },
    content_type: 'terminal',
    entity_id: 'terminal-tab-1',
    group_id: 'group-1',
    title: 'Build',
    revision: 2,
    availability: 'available',
    binding: {
      kind: 'terminal',
      terminal_tab_id: 'terminal-tab-1',
      pane_key: 'pane-1',
      session_id: 'pty-1',
      pty_incarnation: 'incarnation-1',
      liveness: 'live',
      authority_revision: 2
    }
  }
}

describe('MaestroWorkspaceWindow', () => {
  beforeEach(() => Object.values(callbacks).forEach((callback) => callback.mockClear()))
  afterEach(cleanup)

  it('replaces an exact generated worker title with the authoritative function', () => {
    expect(
      resolveMaestroWorkspaceSurfaceTitle(
        'worker-task_desktop',
        'Desktop progress specialist',
        'task_desktop'
      )
    ).toBe('Desktop progress specialist')
  })

  it('replaces an opaque Task id even when an older surface title includes worker metadata', () => {
    expect(
      resolveMaestroWorkspaceSurfaceTitle(
        'task_355f776fd0fc · worker · Agent',
        'Research open roles',
        'task_355f776fd0fc'
      )
    ).toBe('Research open roles')
  })

  it('preserves an explicit user title that does not match the generated default', () => {
    expect(
      resolveMaestroWorkspaceSurfaceTitle(
        'Accessibility review',
        'Desktop progress specialist',
        'task_desktop'
      )
    ).toBe('Accessibility review')
  })

  it('keeps real terminal output visible without selecting the window', () => {
    render(
      <TooltipProvider>
        <MaestroWorkspaceWindow
          {...callbacks}
          surfaceKey="terminal-1"
          surface={terminal()}
          placement={placement}
          selected={false}
          pending={false}
          linkTarget={false}
          runtimeTarget={{ kind: 'local' }}
        />
      </TooltipProvider>
    )
    expect(
      document
        .querySelector('[data-terminal-preview="pty-1"]')
        ?.getAttribute('data-terminal-preview-mode')
    ).toBe('canvas')
  })

  it('lets terminal input receive pointer and focus without a Canvas focus mutation', () => {
    render(
      <TooltipProvider>
        <MaestroWorkspaceWindow
          {...callbacks}
          surfaceKey="terminal-1"
          surface={terminal()}
          placement={placement}
          selected
          pending={false}
          linkTarget={false}
          runtimeTarget={{ kind: 'local' }}
        />
      </TooltipProvider>
    )
    const input = screen.getByLabelText('Exact terminal input')
    const pointer = new Event('pointerdown', { bubbles: true, cancelable: true })
    input.dispatchEvent(pointer)
    input.focus()
    input.dispatchEvent(new Event('input', { bubbles: true }))

    expect(pointer.defaultPrevented).toBe(false)
    expect(callbacks.onSelect).not.toHaveBeenCalled()
    expect(callbacks.onRename).not.toHaveBeenCalled()
    expect(callbacks.onFocus).not.toHaveBeenCalled()
  })

  describe('inline rename', () => {
    it('commits a trimmed title with Enter without opening a separate surface', () => {
      render(
        <TooltipProvider>
          <MaestroWorkspaceWindow
            {...callbacks}
            surfaceKey="terminal-1"
            surface={terminal()}
            placement={placement}
            selected
            pending={false}
            linkTarget={false}
            runtimeTarget={{ kind: 'local' }}
          />
        </TooltipProvider>
      )

      fireEvent.click(screen.getByRole('button', { name: 'Rename tab' }))
      const titleInput = screen.getByRole('textbox', { name: 'Tab title' })
      fireEvent.change(titleInput, { target: { value: '  Compile  ' } })
      fireEvent.keyDown(titleInput, { key: 'Enter' })

      expect(callbacks.onRename).toHaveBeenCalledOnce()
      expect(callbacks.onRename).toHaveBeenCalledWith('Compile')
      expect(screen.queryByRole('textbox', { name: 'Tab title' })).toBeNull()
    })

    it('cancels with Escape and ignores an empty blur', () => {
      render(
        <TooltipProvider>
          <MaestroWorkspaceWindow
            {...callbacks}
            surfaceKey="terminal-1"
            surface={terminal()}
            placement={placement}
            selected
            pending={false}
            linkTarget={false}
            runtimeTarget={{ kind: 'local' }}
          />
        </TooltipProvider>
      )

      fireEvent.click(screen.getByRole('button', { name: 'Rename tab' }))
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Tab title' }), { key: 'Escape' })
      fireEvent.click(screen.getByRole('button', { name: 'Rename tab' }))
      const titleInput = screen.getByRole('textbox', { name: 'Tab title' })
      fireEvent.change(titleInput, { target: { value: '   ' } })
      fireEvent.blur(titleInput)

      expect(callbacks.onRename).not.toHaveBeenCalled()
      expect(screen.queryByRole('textbox', { name: 'Tab title' })).toBeNull()
    })
  })

  it('avoids committing placement when a header click has no movement', () => {
    render(
      <TooltipProvider>
        <MaestroWorkspaceWindow
          {...callbacks}
          surfaceKey="terminal-1"
          surface={terminal()}
          placement={placement}
          selected={false}
          pending={false}
          linkTarget={false}
          runtimeTarget={{ kind: 'local' }}
        />
      </TooltipProvider>
    )
    const header = screen.getByText('Build').closest('header')
    expect(header).not.toBeNull()
    fireEvent.pointerDown(header!, { pointerId: 1, clientX: 40, clientY: 20 })
    fireEvent.pointerUp(header!, { pointerId: 1, clientX: 40, clientY: 20 })

    expect(callbacks.onSelect).toHaveBeenCalledOnce()
    expect(callbacks.onMoveCommit).not.toHaveBeenCalled()
  })

  it('scales drag deltas into world units by the canvas zoom', () => {
    render(
      <TooltipProvider>
        <MaestroWorkspaceWindow
          {...callbacks}
          surfaceKey="terminal-1"
          surface={terminal()}
          placement={placement}
          selected={false}
          pending={false}
          linkTarget={false}
          runtimeTarget={{ kind: 'local' }}
          worldZoom={0.5}
        />
      </TooltipProvider>
    )
    const header = screen.getByText('Build').closest('header')
    fireEvent.pointerDown(header!, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(header!, { pointerId: 1, clientX: 30, clientY: 40 })
    fireEvent.pointerUp(header!, { pointerId: 1, clientX: 30, clientY: 40 })

    const windowElement = document.querySelector<HTMLElement>('[data-maestro-workspace-surface]')
    const preview = document.querySelector<HTMLElement>('[data-maestro-workspace-gesture-preview]')
    expect(windowElement?.style.transform).toBe('')
    expect(preview?.style.transform).toBe('translate(40px, 60px)')
    expect(callbacks.onMoveCommit).toHaveBeenCalledWith({ x: 40, y: 60 })
  })

  it('previews resize on a lightweight outline before committing the window size', () => {
    render(
      <TooltipProvider>
        <MaestroWorkspaceWindow
          {...callbacks}
          surfaceKey="terminal-1"
          surface={terminal()}
          placement={placement}
          selected={false}
          pending={false}
          linkTarget={false}
          runtimeTarget={{ kind: 'local' }}
          worldZoom={0.5}
        />
      </TooltipProvider>
    )
    const resize = screen.getByRole('button', { name: 'Resize Build' })
    fireEvent.pointerDown(resize, { pointerId: 1, clientX: 10, clientY: 10 })
    fireEvent.pointerMove(resize, { pointerId: 1, clientX: 26, clientY: 21 })

    const windowElement = document.querySelector<HTMLElement>('[data-maestro-workspace-surface]')
    const preview = document.querySelector<HTMLElement>('[data-maestro-workspace-gesture-preview]')
    fireEvent.pointerUp(resize, { pointerId: 1, clientX: 26, clientY: 21 })

    expect(windowElement?.style.transform).toBe('')
    expect(preview?.style.transform).toBe('scale(1.1, 1.1)')
    expect(callbacks.onResizeCommit).toHaveBeenCalledWith({ x: 32, y: 22 })
  })

  it('renders the exact existing Browser page through the capture preview', () => {
    const surface: WorkspaceSurface = {
      id: { ...scope, unified_tab_id: 'tab-2' },
      content_type: 'browser',
      entity_id: 'browser-workspace-1',
      group_id: 'group-1',
      title: 'Docs',
      revision: 2,
      availability: 'available',
      binding: {
        kind: 'browser',
        browser_workspace_id: 'browser-workspace-1',
        browser_page_id: 'page-1',
        profile_id: null,
        partition_id: null,
        authority_revision: 2,
        live_frame: null,
        immutable_capture: null
      }
    }
    render(
      <TooltipProvider>
        <MaestroWorkspaceWindow
          {...callbacks}
          surfaceKey="browser-1"
          surface={surface}
          placement={placement}
          selected={false}
          pending={false}
          linkTarget={false}
          runtimeTarget={{ kind: 'local' }}
        />
      </TooltipProvider>
    )
    const windowElement = document.querySelector('[data-maestro-workspace-surface="browser-1"]')
    expect(windowElement?.getAttribute('data-maestro-workspace-tab-id')).toBe('tab-2')
    expect(windowElement?.getAttribute('data-maestro-workspace-content-type')).toBe('browser')
    expect(windowElement?.getAttribute('data-maestro-browser-page-id')).toBe('page-1')
    expect(document.querySelector('[data-browser-preview="page-1"]')).not.toBeNull()
  })
})
