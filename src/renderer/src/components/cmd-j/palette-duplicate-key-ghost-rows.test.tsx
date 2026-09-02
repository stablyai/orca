// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { buildPaletteListEntryRenderKeys } from './palette-list-entry-render-keys'

/**
 * Regression for the Cmd+J ghost rows: a windows-low-spec session persisted two
 * tab records under one id, so two rows shared a React key. When the query
 * narrowed and the rows stopped matching, React had one fiber for the two keys
 * and never unmounted the extra — it stayed above the section headers, frozen at
 * the highlight ranges of the keystroke that last matched it.
 */
type Row = { id: string; label: string }

function PaletteList({ rows, uniqueKeys }: { rows: Row[]; uniqueKeys: boolean }) {
  const renderKeys = uniqueKeys
    ? buildPaletteListEntryRenderKeys(rows.map((row) => row.id))
    : rows.map((row) => row.id)
  return (
    <div>
      {rows.map((row, index) => (
        <span key={renderKeys[index]}>{row.label}</span>
      ))}
    </div>
  )
}

// The duplicated pair, as persisted for the lungfish worktree.
const DUPLICATE_TAB_ID = 'workspace-tab:editor:lungfish:FINAL-REPORT.md'

function rowsForQuery(query: string): Row[] {
  // "l" matches the worktree name; "li" and beyond match nothing in that workspace.
  const remoteRows =
    query === 'l'
      ? [
          { id: DUPLICATE_TAB_ID, label: `[lungfish ${query}-hit]` },
          { id: DUPLICATE_TAB_ID, label: `[lungfish ${query}-hit]` }
        ]
      : []
  return [...remoteRows, { id: '__header_open_tabs__', label: '(OPEN TABS)' }]
}

async function typeQuery(uniqueKeys: boolean): Promise<string> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  for (const query of ['l', 'li', 'lin', 'line', 'linea', 'linear']) {
    await act(async () => {
      root.render(<PaletteList rows={rowsForQuery(query)} uniqueKeys={uniqueKeys} />)
    })
  }
  const rendered = host.textContent ?? ''
  root.unmount()
  host.remove()
  return rendered
}

describe('duplicate persisted tab ids in the Cmd+J list', () => {
  it('strands a ghost row when the render key repeats', async () => {
    // Why assert the bug: it is the reason the disambiguated key exists.
    expect(await typeQuery(false)).toBe('[lungfish l-hit](OPEN TABS)')
  })

  it('leaves nothing behind once render keys are disambiguated', async () => {
    expect(await typeQuery(true)).toBe('(OPEN TABS)')
  })
})
