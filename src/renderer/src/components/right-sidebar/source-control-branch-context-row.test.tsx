import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { SourceControlBranchContextRow } from './source-control-branch-context-row'
import type { GitBranchCompareSummary } from '../../../../shared/types'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const readySummary: GitBranchCompareSummary = {
  baseRef: 'refs/remotes/origin/FRONT-192-ZisVoucherStrip',
  baseOid: 'base',
  compareRef: 'feature',
  headOid: 'head',
  mergeBase: 'base',
  changedFiles: 0,
  commitsAhead: 0,
  status: 'ready'
}

describe('SourceControlBranchContextRow', () => {
  it('lets the base ref use the full available header width', () => {
    const markup = renderToStaticMarkup(
      <SourceControlBranchContextRow
        summary={readySummary}
        compareBaseRef={null}
        onChangeBaseRef={vi.fn()}
        onRetry={vi.fn()}
      />
    )

    expect(markup).toContain('refs/remotes/origin/FRONT-192-ZisVoucherStrip')
    expect(markup).toContain('max-w-full')
    expect(markup).toContain('min-w-0 flex-1')
    expect(markup).not.toContain('max-w-[9rem]')
  })
})
