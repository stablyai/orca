// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))
}))

import { OperationRow, type OperationRowProps } from './operation-row'

const BRANCH = 'feature/very-long-example-branch-name-for-testing'

function renderRow(props: Partial<OperationRowProps> = {}) {
  return render(
    <TooltipProvider delayDuration={0}>
      <OperationRow
        operation="rebase"
        branch={BRANCH}
        primary={{ kind: 'resolve', busy: false, onPress: () => {} }}
        abort={{ unavailable: false, busy: false, onAbort: () => {} }}
        abortTargetKey="test|rebase"
        {...props}
      />
    </TooltipProvider>
  )
}

/** The visible two-line label (hidden from assistive tech; the status region speaks for it). */
function visibleLabel(container: HTMLElement): HTMLElement {
  const label = container.querySelector<HTMLElement>(
    '[data-testid="source-control-operation-row"] [aria-hidden="true"]'
  )
  if (!label) {
    throw new Error('operation label not rendered')
  }
  return label
}

describe('OperationRow', () => {
  afterEach(() => cleanup())

  it('stacks the verb over the branch, each on its own truncating line in the sans family', () => {
    const { container } = renderRow()
    const lines = Array.from(visibleLabel(container).children) as HTMLElement[]
    expect(lines.map((line) => line.textContent)).toEqual(['Rebasing', BRANCH])
    for (const line of lines) {
      expect(line.className).toContain('truncate')
      expect(line.className).not.toContain('font-mono')
    }
    expect(lines[0].className).toContain('font-medium')
    expect(lines[1].className).toContain('text-muted-foreground')
  })

  it('shows a detail on the branch line in place of the branch', () => {
    const { container } = renderRow({ detail: 'Check failed' })
    const lines = Array.from(visibleLabel(container).children)
    expect(lines.map((line) => line.textContent)).toEqual(['Rebasing', 'Check failed'])
  })

  it('shows the verb alone when there is no branch', () => {
    const { container } = renderRow({ branch: null, operation: 'merge' })
    const lines = Array.from(visibleLabel(container).children)
    expect(lines.map((line) => line.textContent)).toEqual(['Merging'])
  })

  it('keeps the sparkle on Resolve', () => {
    renderRow()
    const resolve = screen.getByRole('button', { name: 'Resolve conflicts with AI' })
    expect(resolve.textContent).toBe('Resolve')
    expect(resolve.querySelector('svg')).not.toBeNull()
  })

  it('puts the full branch in the label tooltip', async () => {
    const { container } = renderRow()
    const trigger = container.querySelector<HTMLElement>(
      '[data-testid="source-control-operation-row"] [tabindex="0"]'
    )
    expect(trigger).not.toBeNull()
    fireEvent.focus(trigger!)
    await waitFor(() =>
      expect(screen.getByRole('tooltip').textContent).toContain(`Rebasing ${BRANCH}`)
    )
  })
})
