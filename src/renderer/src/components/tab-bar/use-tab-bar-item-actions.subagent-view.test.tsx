// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { TabBarProps } from './tab-bar-props'
import { useTabBarItemActions, type TabBarItemActions } from './use-tab-bar-item-actions'

const VIEW = {
  agentId: 'a1',
  name: 'Explore battle scripts',
  parentTranscriptPath: '/p/693d.jsonl'
}

function renderActions(onActivate: TabBarProps['onActivate']): TabBarItemActions {
  let actions: TabBarItemActions | null = null
  function Probe(): null {
    actions = useTabBarItemActions({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activateTerminal reads only onActivate.
      props: { onActivate } as unknown as Parameters<typeof useTabBarItemActions>[0]['props'],
      togglePinned: () => {},
      toggleTabViewMode: () => {}
    })
    return null
  }
  const root = createRoot(document.createElement('div'))
  act(() => root.render(<Probe />))
  if (!actions) {
    throw new Error('expected the tab bar actions')
  }
  return actions
}

describe('clicking a terminal tab', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    useAppStore.setState({
      paneSubagentViewByPaneKey: {
        'terminal-1:11111111-1111-4111-8111-111111111111': VIEW,
        'terminal-2:11111111-1111-4111-8111-111111111111': VIEW
      }
    })
  })

  it("returns that tab's panes to their main agents and leaves other tabs alone", () => {
    const onActivate = vi.fn()
    renderActions(onActivate).activateTerminal('terminal-1')

    expect(onActivate).toHaveBeenCalledWith('terminal-1')
    expect(useAppStore.getState().paneSubagentViewByPaneKey).toEqual({
      'terminal-2:11111111-1111-4111-8111-111111111111': VIEW
    })
  })
})
