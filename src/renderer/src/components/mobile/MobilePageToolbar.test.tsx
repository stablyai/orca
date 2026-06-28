// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

import { MobilePageToolbar } from './MobilePageToolbar'

describe('MobilePageToolbar', () => {
  it('labels the sidebar toggle explicitly when Orca Mobile is visible in the sidebar', () => {
    const html = renderToStaticMarkup(
      <MobilePageToolbar showMobileButton onClose={vi.fn()} onToggleMobileSidebarButton={vi.fn()} />
    )

    expect(html).toContain('Remove Orca Mobile from left sidebar')
    expect(html).toContain('mp-page-toolbar-primary')
    expect(html).toContain('Configure in Settings')
    expect(html).not.toContain('Hide from sidebar')
  })

  it('labels the restore action explicitly when Orca Mobile is hidden from the sidebar', () => {
    const html = renderToStaticMarkup(
      <MobilePageToolbar
        showMobileButton={false}
        onClose={vi.fn()}
        onToggleMobileSidebarButton={vi.fn()}
      />
    )

    expect(html).toContain('Show Orca Mobile in left sidebar')
    expect(html).not.toContain('Show in sidebar')
  })
})
