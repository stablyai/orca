// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { PtyManagementGeneration, PtyManagementSession } from '../../../../preload/api-types'
import { GenerationRows } from './ManageSessionsGenerationRows'

function session(backsTab: boolean): PtyManagementSession {
  return {
    sessionId: 'wt@@dup',
    state: 'running',
    shellState: 'ready',
    isAlive: true,
    pid: 1,
    cwd: '/repo/wt',
    cols: 80,
    rows: 24,
    createdAt: 0,
    protocolVersion: backsTab ? 36 : 35,
    backsTab
  }
}

function renderGenerations(generations: PtyManagementGeneration[], onNavigate = vi.fn()) {
  render(
    <table>
      {generations.map((generation, index) => (
        <GenerationRows
          key={generation.protocolVersion}
          generation={generation}
          showHeader
          isFirstGroup={index === 0}
          isBusy={false}
          ptyIdToTabId={new Map([['wt@@dup', 'tab-1']])}
          onNavigate={onNavigate}
          onRequestKill={vi.fn()}
        />
      ))}
    </table>
  )
  return onNavigate
}

describe('Manage Sessions rows for the same id in two versions', () => {
  afterEach(() => cleanup())

  it('lets only the copy the tab shows open the tab', () => {
    const onNavigate = renderGenerations([
      { protocolVersion: 36, isCurrent: true, contact: 'live', sessions: [session(true)] },
      { protocolVersion: 35, isCurrent: false, contact: 'live', sessions: [session(false)] }
    ])

    const navigable = screen.getAllByRole('row', { name: /Go to terminal/ })
    expect(navigable).toHaveLength(1)
    fireEvent.click(navigable[0]!)
    expect(onNavigate).toHaveBeenCalledExactlyOnceWith('tab-1')
  })

  it('labels each version group as a row group and words an uncounted one', () => {
    renderGenerations([
      { protocolVersion: 36, isCurrent: true, contact: 'live', sessions: [session(true)] },
      {
        protocolVersion: 35,
        isCurrent: false,
        contact: 'unverifiable',
        reason: 'listing-failed',
        detail: null
      }
    ])

    expect(screen.getAllByRole('rowheader')).toHaveLength(2)
    expect(screen.getByText('unverifiable')).toBeInTheDocument()
    expect(screen.getByText(/They are not known to have stopped/)).toBeInTheDocument()
  })
})
