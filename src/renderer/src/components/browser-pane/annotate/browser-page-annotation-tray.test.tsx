// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BrowserPageAnnotation } from '../../../../../shared/browser-grab-types'
import { BrowserPageAnnotationTray } from './browser-page-annotation-tray'

afterEach(() => {
  cleanup()
})

function makeAnnotation(): BrowserPageAnnotation {
  return {
    id: 'annotation-1',
    browserPageId: 'page-1',
    comment: 'Fix this button',
    intent: 'change',
    priority: 'important',
    createdAt: '2026-05-15T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: 'https://example.com',
        title: 'Example',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        capturedAt: '2026-05-15T00:00:00.000Z'
      },
      target: {
        tagName: 'button',
        selector: 'button',
        textSnippet: 'Submit',
        htmlSnippet: '<button>Submit</button>',
        attributes: {},
        accessibility: {
          role: 'button',
          accessibleName: 'Submit',
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: { x: 0, y: 0, width: 100, height: 40 },
        rectPage: { x: 0, y: 0, width: 100, height: 40 },
        computedStyles: {
          display: 'inline-flex',
          position: 'static',
          width: '100px',
          height: '40px',
          margin: '0px',
          padding: '0px',
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          border: '0px none',
          borderRadius: '0px',
          fontFamily: 'Geist',
          fontSize: '14px',
          fontWeight: '400',
          lineHeight: '20px',
          textAlign: 'center',
          zIndex: 'auto'
        }
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null
    }
  }
}

function renderTray(): {
  handleDeleteBrowserAnnotation: ReturnType<typeof vi.fn>
  handleUpdateBrowserAnnotation: ReturnType<typeof vi.fn>
} {
  const handleDeleteBrowserAnnotation = vi.fn()
  const handleUpdateBrowserAnnotation = vi.fn()

  render(
    <TooltipProvider>
      <BrowserPageAnnotationTray
        browserAnnotations={[makeAnnotation()]}
        annotationTraySendOpen={false}
        handleAnnotationTraySendOpenChange={vi.fn()}
        worktreeId="wt-1"
        activeGroupId={undefined}
        browserAnnotationsPrompt="prompt"
        handleBrowserAnnotationsSentToAgent={vi.fn()}
        handleCopyBrowserAnnotations={vi.fn()}
        browserAnnotationsCopied={false}
        handleClearBrowserAnnotations={vi.fn()}
        handleDeleteBrowserAnnotation={handleDeleteBrowserAnnotation}
        handleUpdateBrowserAnnotation={handleUpdateBrowserAnnotation}
      />
    </TooltipProvider>
  )

  return { handleDeleteBrowserAnnotation, handleUpdateBrowserAnnotation }
}

describe('BrowserPageAnnotationTray edit mode', () => {
  it('seeds the textarea with the current comment when entering edit mode', () => {
    renderTray()

    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }))

    expect(screen.getByRole('textbox', { name: 'Annotation comment' })).toHaveValue(
      'Fix this button'
    )
  })

  it('saves the trimmed comment and the chosen intent', () => {
    const { handleUpdateBrowserAnnotation } = renderTray()

    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Annotation comment' }), {
      target: { value: '  Updated comment  ' }
    })
    fireEvent.click(screen.getByRole('radio', { name: 'Question' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(handleUpdateBrowserAnnotation).toHaveBeenCalledWith(
      'annotation-1',
      'Updated comment',
      'question'
    )
  })

  it('restores the read view on cancel without saving', () => {
    const { handleUpdateBrowserAnnotation } = renderTray()

    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Annotation comment' }), {
      target: { value: 'Changed but cancelled' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(handleUpdateBrowserAnnotation).not.toHaveBeenCalled()
    expect(screen.getByText('Fix this button')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Annotation comment' })).not.toBeInTheDocument()
  })

  it('restores the read view when Escape fires from the intent toggle group', () => {
    const { handleUpdateBrowserAnnotation } = renderTray()

    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }))
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Question' }), {
      key: 'Escape',
      bubbles: true
    })

    expect(handleUpdateBrowserAnnotation).not.toHaveBeenCalled()
    expect(screen.getByText('Fix this button')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Annotation comment' })).not.toBeInTheDocument()
  })
})

function disclosureTargets(control: HTMLElement): HTMLElement[] {
  const ids = control.getAttribute('aria-controls')?.split(/\s+/).filter(Boolean) ?? []
  expect(ids).toHaveLength(2)
  const nodes: HTMLElement[] = []
  for (const id of ids) {
    const node = document.getElementById(id)
    expect(node).toBeInstanceOf(HTMLElement)
    if (node instanceof HTMLElement) {
      nodes.push(node)
    }
  }
  expect(nodes).toHaveLength(2)
  return nodes
}

describe('BrowserPageAnnotationTray collapse', () => {
  it('starts expanded with Send, Copy, and Delete available', () => {
    renderTray()

    const collapseControl = screen.getByRole('button', { name: 'Collapse annotations' })
    expect(collapseControl).toHaveAttribute('aria-expanded', 'true')
    expect(collapseControl.querySelector('svg.lucide-chevron-up')).not.toBeNull()
    expect(collapseControl.querySelector('svg.lucide-chevron-down')).toBeNull()
    const [actions, list] = disclosureTargets(collapseControl)
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Send' }))
    expect(list).toContainElement(screen.getByText('Fix this button'))
    expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Clear browser annotations' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete annotation 1' })).toBeInTheDocument()
    expect(screen.getByText('Fix this button')).toBeVisible()
  })

  it('hides details and keeps the annotation count when collapsed', () => {
    renderTray()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse annotations' }))

    expect(screen.getByText('1 annotation')).toBeVisible()
    const expandControl = screen.getByRole('button', { name: 'Expand annotations' })
    expect(expandControl).toHaveAttribute('aria-expanded', 'false')
    expect(expandControl.querySelector('svg.lucide-chevron-down')).not.toBeNull()
    expect(expandControl.querySelector('svg.lucide-chevron-up')).toBeNull()
    for (const node of disclosureTargets(expandControl)) {
      expect(node).toHaveAttribute('hidden')
    }
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Clear browser annotations' })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete annotation 1' })).not.toBeInTheDocument()
    expect(screen.getByText('Fix this button')).not.toBeVisible()
  })

  it('restores details without losing annotations after expand', () => {
    renderTray()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse annotations' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand annotations' }))

    expect(screen.getByText('Fix this button')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Send' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Clear browser annotations' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Delete annotation 1' })).toBeInTheDocument()
    const collapseControl = screen.getByRole('button', { name: 'Collapse annotations' })
    expect(collapseControl).toHaveAttribute('aria-expanded', 'true')
    expect(collapseControl.querySelector('svg.lucide-chevron-up')).not.toBeNull()
    for (const node of disclosureTargets(collapseControl)) {
      expect(node).not.toHaveAttribute('hidden')
    }
  })

  it('names the collapse control for assistive tech', () => {
    renderTray()

    const collapseControl = screen.getByRole('button', { name: 'Collapse annotations' })
    expect(collapseControl).toBeVisible()
    expect(collapseControl).toHaveAttribute('aria-controls')
  })

  it('keeps an in-progress edit after collapse and expand', () => {
    const { handleUpdateBrowserAnnotation } = renderTray()

    fireEvent.click(screen.getByRole('button', { name: 'Edit annotation 1' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Annotation comment' }), {
      target: { value: 'Draft that must survive collapse' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Collapse annotations' }))
    fireEvent.click(screen.getByRole('button', { name: 'Expand annotations' }))

    expect(screen.getByRole('textbox', { name: 'Annotation comment' })).toHaveValue(
      'Draft that must survive collapse'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(handleUpdateBrowserAnnotation).toHaveBeenCalledWith(
      'annotation-1',
      'Draft that must survive collapse',
      'change'
    )
  })
})
