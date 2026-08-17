// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { FolderWorkspacePathStatus } from '../../../../../../shared/folder-workspace-path-status'
import { FolderPathStatusIndicator } from './FolderPathStatusIndicator'

// Why: the status is cast, not decoded, off the runtime RPC wire, so a newer host really can put a
// reason this build has never heard of on the wire; the cast at the boundary is the point.
function renderIndicator(reason: unknown): string {
  const status = {
    path: '/srv/scans',
    exists: false,
    reason
  } as unknown as FolderWorkspacePathStatus
  return renderToStaticMarkup(
    <TooltipProvider>
      <FolderPathStatusIndicator status={status} />
    </TooltipProvider>
  )
}

describe('FolderPathStatusIndicator', () => {
  it('marks a folder missing for a declared reason', () => {
    const markup = renderIndicator('missing')

    expect(markup).toContain('aria-label="Folder not found"')
    expect(markup).toContain('text-destructive')
  })

  // Why: losing the marker is worse than an imprecise one — the sidebar then renders a broken
  // folder workspace as healthy, with nothing to click and nothing to read.
  it('still renders the marker when a newer host sends an undeclared reason', () => {
    const markup = renderIndicator('permission-denied')

    expect(markup).not.toBe('')
    expect(markup).toContain('aria-label="')
    expect(markup).not.toContain('aria-label=""')
    // Why: an imprecise label must not borrow a specific cause it cannot substantiate.
    expect(markup).not.toContain('aria-label="Folder not found"')
    // Why: unknown is not confirmed stale, so the marker stays neutral rather than destructive.
    expect(markup).toContain('text-muted-foreground')
  })

  it('still renders the marker when the wire carries a non-string reason', () => {
    const markup = renderIndicator(['missing'])

    expect(markup).not.toBe('')
    expect(markup).toContain('aria-label="')
    expect(markup).not.toContain('aria-label=""')
    // Why: hasOwn coerces its key, so ['missing'] must not be read as the confirmed-stale 'missing'.
    expect(markup).not.toContain('aria-label="Folder not found"')
  })

  it('renders nothing for a healthy folder', () => {
    const markup = renderToStaticMarkup(
      <TooltipProvider>
        <FolderPathStatusIndicator status={{ path: '/srv/scans', exists: true }} />
      </TooltipProvider>
    )

    expect(markup).toBe('')
  })
})
