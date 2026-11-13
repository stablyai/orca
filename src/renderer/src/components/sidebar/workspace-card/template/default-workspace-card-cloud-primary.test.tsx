// PAIRED-BADGE: the "primary" badge and star the LIVE card template draws (default-workspace-card.json
// through the element registry) are gated on the cloud row check, so an Orca Cloud workspace's own
// checkout (owned, or paired from birth) never reads as a repo's primary checkout. #560 put this gate
// in a header nothing rendered; this test goes through the registry the sidebar actually uses.
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('@/lib/orca-cloud/cloud-host-rows', () => ({
  // A paired-from-birth row is on its "(cloud)" server; the hook itself is covered in its own test.
  useIsCloudHostRow: (row: { hostId?: string | null }) => row.hostId === 'runtime:env-gh'
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { WORKSPACE_CARD_ELEMENTS } from './card-element-registry'
import { compileCardTemplate } from './card-template-compiler'
import { DEFAULT_WORKSPACE_CARD_TEMPLATE } from './default-workspace-card'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'

function renderElement(el: 'PrimaryBadge' | 'PrimaryStar', hostId: string): string {
  const compiled = compileCardTemplate(
    { ...DEFAULT_WORKSPACE_CARD_TEMPLATE, defs: undefined, root: { el } },
    WORKSPACE_CARD_ELEMENTS
  )
  const worktree = {
    id: 'push-test::/workspace/orca-sandbox-push-test',
    hostId,
    isMainWorktree: true
  }
  const fields = { worktree, newCardStyle: false, detailsHoverControl: null }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these parts read only `worktree`, `newCardStyle` and `detailsHoverControl`.
  const card = fields as unknown as WorktreeCardController
  return renderToStaticMarkup(
    <TooltipProvider>{compiled.render({}, card).content}</TooltipProvider>
  )
}

describe('the live card template on an Orca Cloud workspace row', () => {
  it('the template the sidebar renders still draws both parts', () => {
    const json = JSON.stringify(DEFAULT_WORKSPACE_CARD_TEMPLATE)
    expect(json).toContain('"el":"PrimaryBadge"')
    expect(json).toContain('"el":"PrimaryStar"')
  })

  it('a paired-from-birth cloud row gets no "primary" badge and no star', () => {
    expect(renderElement('PrimaryBadge', 'runtime:env-gh')).not.toContain('primary')
    expect(renderElement('PrimaryStar', 'runtime:env-gh')).toBe('')
  })

  it('a local primary checkout keeps both', () => {
    expect(renderElement('PrimaryBadge', 'local')).toContain('primary')
    expect(renderElement('PrimaryStar', 'local')).toContain('Primary worktree')
  })
})
