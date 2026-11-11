// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentAccountsOverview } from './AgentAccountsOverview'
import type { OverviewRow } from './agent-accounts-overview-model'

const CLOUD: OverviewRow = {
  id: 'cloud',
  hostId: null,
  label: 'Orca Cloud',
  kind: 'cloud',
  availability: 'available',
  cells: { claude: { kind: 'cloudAccount' }, codex: { kind: 'cloudAccount' } },
  attention: false,
  action: null
}

function overview(rows: readonly OverviewRow[]): void {
  render(
    <AgentAccountsOverview
      rows={rows}
      signedOutOfOrca={false}
      summary=""
      onOpenRow={vi.fn()}
      onAction={vi.fn()}
    />
  )
}

describe('AgentAccountsOverview (RA-5)', () => {
  afterEach(cleanup)

  it('says nothing needs attention instead of an empty table', () => {
    overview([CLOUD])
    fireEvent.click(screen.getByRole('radio', { name: 'Needs attention · 0' }))
    expect(screen.getByText('Nothing needs attention.')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('never truncates the host name or its detail: they stack (RA-5, JA-23)', () => {
    overview([CLOUD])
    const name = screen.getByText('Orca Cloud', { selector: 'span' })
    expect(name.className).not.toContain('truncate')
    expect(screen.getByText('all your cloud workspaces').className).not.toContain('truncate')
  })

  it('has no "Signed in means…" footnote (JA-23)', () => {
    overview([CLOUD])
    expect(screen.queryByText(/confirmed it in the last minute/)).toBeNull()
  })
})
