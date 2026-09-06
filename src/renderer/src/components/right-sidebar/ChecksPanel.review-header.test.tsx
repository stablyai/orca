import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChecksPanelReviewHeader } from './ChecksPanel'
import type { ChecksPanelHostedReviewModifierDestination } from './checks-panel-hosted-review-click-routing'

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode; asChild?: boolean }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => <div data-disabled={disabled ? 'true' : undefined}>{children}</div>
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

beforeEach(() => {
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderHeader({
  canUnlinkReview = true,
  provider = 'github',
  modifierHintDestination = 'system-browser'
}: {
  canUnlinkReview?: boolean
  provider?: 'github' | 'gitlab'
  modifierHintDestination?: ChecksPanelHostedReviewModifierDestination
} = {}): string {
  const isGitLab = provider === 'gitlab'
  return renderToStaticMarkup(
    <ChecksPanelReviewHeader
      review={{
        provider,
        number: isGitLab ? 31 : 2964,
        title: isGitLab ? 'Fix GitLab MR creation' : 'fix: pr-bug-scan validated finding',
        state: 'open',
        url: isGitLab
          ? 'https://gitlab.com/acme/orca/-/merge_requests/31'
          : 'https://github.com/stablyai/orca/pull/2964',
        status: 'pending',
        updatedAt: '2026-05-31T22:58:01Z',
        mergeable: 'UNKNOWN'
      }}
      isRefreshing={false}
      canUnlinkReview={canUnlinkReview}
      modifierHintDestination={modifierHintDestination}
      onRefresh={vi.fn()}
      onOpenReview={vi.fn()}
      onUnlinkReview={vi.fn()}
      onLinkAnotherReview={vi.fn()}
    />
  )
}

describe('ChecksPanelReviewHeader', () => {
  it('opens the PR from the number and puts link management behind the menu', () => {
    const markup = renderHeader()

    expect(markup).toContain('Open on GitHub')
    expect(markup).toContain('system browser')
    expect(markup).toContain('⇧⌘+click')
    expect(markup).not.toContain('⌘+click to open')
    expect(markup).toContain('#2964')
    expect(markup).toContain('underline decoration-border underline-offset-2')
    expect(markup).toContain('More PR actions')
    expect(markup).toContain('Unlink PR from workspace')
    expect(markup).toContain(
      'Orca will hide PR #2964 details for this workspace. The PR and branch on GitHub won’t be changed.'
    )
    expect(markup).toContain('Link another PR')
    expect(markup).toContain('lucide-ellipsis')
    expect(markup).not.toContain('lucide-external-link')
  })

  it('omits the modifier hint when it lands where a plain click already does', () => {
    const markup = renderHeader({ modifierHintDestination: null })

    expect(markup).toContain('Open on GitHub')
    expect(markup).not.toContain('system browser')
    expect(markup).not.toContain('⇧⌘+click')
  })

  // Why: with inverting on and Link Routing off the modifier reaches Orca here, so the
  // hint must name Orca rather than the destination a plain click already uses.
  it('names Orca when the modifier inverts toward the built-in browser', () => {
    expect(renderHeader({ modifierHintDestination: 'orca' })).toContain('⇧⌘+click to open in Orca')

    vi.stubGlobal('navigator', { userAgent: 'Windows' })
    expect(renderHeader({ modifierHintDestination: 'orca' })).toContain(
      'Shift+Ctrl+click to open in Orca'
    )
  })

  it('shows the Ctrl system-browser hint off macOS', () => {
    vi.stubGlobal('navigator', { userAgent: 'Windows' })

    const markup = renderHeader()

    expect(markup).toContain('Shift+Ctrl+click for system browser')
    expect(markup).not.toContain('Ctrl+click to open')
  })

  it('enables unlinking for a displayed auto-detected PR', () => {
    const markup = renderHeader({ canUnlinkReview: true })

    expect(markup).not.toContain('data-disabled="true"')
    expect(markup).toContain('Unlink PR from workspace')
  })

  it('shows GitLab MR identity with provider-appropriate link management actions', () => {
    const markup = renderHeader({ provider: 'gitlab' })

    expect(markup).toContain('Open on GitLab')
    expect(markup).toContain('!31')
    expect(markup).toContain('More MR actions')
    expect(markup).toContain('Unlink MR from workspace')
    expect(markup).toContain(
      'Orca will hide MR !31 details for this workspace. The MR and branch on GitLab won’t be changed.'
    )
    expect(markup).toContain('Link another MR')
  })
})
