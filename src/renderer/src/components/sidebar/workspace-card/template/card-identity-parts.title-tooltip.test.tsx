// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { compileCardExpression } from '../../../../../../shared/workspace-cards/card-expression'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { CARD_IDENTITY_PARTS } from './card-identity-parts'
import defaultCardJson from './default-workspace-card.json'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(() => {
  cleanup()
  // Unmount cleanup does not restore prototype spies.
  vi.restoreAllMocks()
})

const FULL_TITLE = 'Fix the login redirect loop for single sign-on users'

// Evaluates the template's vars in order, as the renderer does, so later vars can read earlier ones.
function compactCardVars(compactHover: boolean): Record<string, unknown> {
  const facts = {
    ws: { title: FULL_TITLE, branch: 'fix/login', name: 'fix-login', kind: 'git' },
    links: { count: 1 },
    ports: { count: 0 },
    options: { style: 'compact', show: {}, compactHover }
  }
  const vars: Record<string, unknown> = {}
  for (const [name, source] of Object.entries(defaultCardJson.vars)) {
    vars[name] = compileCardExpression(source).evaluate({ ...facts, vars })
  }
  return vars
}

function renderCompactTitle(compactHover: boolean): HTMLElement {
  // Make every element overflow, so the title measures as truncated.
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
  const card = {
    affiliateListMode: false,
    isDeleting: false,
    showUnreadEmphasis: false,
    visibleCardTitle: FULL_TITLE,
    worktree: { id: 'wt-1' },
    renamingWorktreeId: null,
    renameRowKey: undefined,
    setTitleRenaming: vi.fn(),
    handleRenameTitle: vi.fn(),
    setRenamingWorktreeId: vi.fn()
  } as unknown as WorktreeCardController
  const props = { dimWhenRead: false, tooltip: !compactCardVars(compactHover).hoverDetails }
  render(
    <TooltipProvider delayDuration={0}>
      {CARD_IDENTITY_PARTS.Title.render(props, [], card)}
    </TooltipProvider>
  )
  return screen.getByText(FULL_TITLE)
}

describe('compact card title tooltip', () => {
  it('shows the full title of a truncated title when the compact hover is off', async () => {
    fireEvent.focus(renderCompactTitle(false))
    expect((await screen.findByRole('tooltip')).textContent).toBe(FULL_TITLE)
  })

  it('leaves the full title to the hover card when the compact hover is on', () => {
    fireEvent.focus(renderCompactTitle(true))
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})
