// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserChromeFoldStage } from './use-browser-chrome-tool-fold'
import type { BrowserChromeFoldedTool } from './browser-chrome-folded-tools'

const mocks = vi.hoisted(() => {
  const stages: readonly BrowserChromeFoldStage[] = []
  return { folded: new Set<BrowserChromeFoldStage>(), stages }
})

vi.mock('./use-browser-chrome-tool-fold', () => ({
  BROWSER_CHROME_FOLD_ORDER: [
    'import-label',
    'external',
    'devtools',
    'share',
    'import',
    'draw',
    'grab',
    'annotate'
  ],
  useBrowserChromeToolFold: (_rowRef: unknown, stages: readonly BrowserChromeFoldStage[]) => {
    mocks.stages = stages
    return mocks.folded
  }
}))

vi.mock('./browser-navigation-control-row', () => ({
  BrowserNavigationControlRow: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  )
}))

vi.mock('../annotate/MarkupDrawButton', () => ({
  MarkupDrawButton: () => <button>Draw</button>
}))

vi.mock('./browser-chrome-element-tool-buttons', () => ({
  BrowserChromeElementToolButtons: () => null
}))

import { BrowserChromeToolbar } from './browser-chrome-toolbar'

const controls = {
  canGoBack: false,
  canGoForward: false,
  loading: false,
  goBack: vi.fn(),
  goForward: vi.fn(),
  reload: vi.fn(),
  navigate: vi.fn()
}
const emptyOverflowMenu = (): null => null

beforeEach(() => {
  mocks.folded = new Set()
  mocks.stages = []
})

afterEach(cleanup)

describe('BrowserChromeToolbar', () => {
  it('does not duplicate an action already provided by the surface menu', () => {
    mocks.folded = new Set(['devtools', 'external'])
    let foldedTools: readonly BrowserChromeFoldedTool[] = []

    render(
      <BrowserChromeToolbar
        controls={controls}
        addressSlot={null}
        elementTools={null}
        markup={{ active: false, disabled: false, onToggle: vi.fn(), canShowDiscoveryHint: false }}
        viewSource={{
          label: 'Open source file',
          onSelect: vi.fn(),
          alreadyInOverflowMenu: true
        }}
        openExternal={{ label: 'Open with default app', onSelect: vi.fn() }}
        overflowMenu={(overflow) => {
          foldedTools = overflow.tools
          return null
        }}
      />
    )

    expect(foldedTools.map((tool) => tool.stage)).toEqual(['external'])
  })

  it('compacts the import hint before removing it', () => {
    mocks.folded = new Set(['import-label'])
    const importControl = vi.fn(() => null)

    render(
      <BrowserChromeToolbar
        controls={controls}
        addressSlot={null}
        importControl={importControl}
        elementTools={null}
        markup={{ active: false, disabled: false, onToggle: vi.fn(), canShowDiscoveryHint: false }}
        viewSource={null}
        openExternal={null}
        overflowMenu={emptyOverflowMenu}
      />
    )

    expect(importControl).toHaveBeenCalledWith(true)
  })

  it('keeps the active tour control out of the fold sequence', () => {
    render(
      <BrowserChromeToolbar
        controls={controls}
        addressSlot={null}
        pinnedStage="grab"
        elementTools={{
          activeIntent: null,
          onStartIntent: vi.fn(),
          disabled: false,
          grabShortcutLabel: 'Cmd+Shift+C',
          annotationCount: 0
        }}
        markup={{ active: false, disabled: false, onToggle: vi.fn(), canShowDiscoveryHint: false }}
        viewSource={null}
        openExternal={null}
        overflowMenu={emptyOverflowMenu}
      />
    )

    expect(mocks.stages).not.toContain('grab')
    expect(mocks.stages).toContain('annotate')
  })

  it('keeps the same share control mounted when it moves into overflow', () => {
    function StatefulShare(): React.JSX.Element {
      const [clicks, setClicks] = useState(0)
      return <button onClick={() => setClicks((count) => count + 1)}>Share state {clicks}</button>
    }
    const props = {
      controls,
      addressSlot: null,
      elementTools: null,
      markup: { active: false, disabled: false, onToggle: vi.fn(), canShowDiscoveryHint: false },
      shareControl: () => <StatefulShare />,
      viewSource: null,
      openExternal: null,
      overflowMenu: emptyOverflowMenu
    }
    const view = render(<BrowserChromeToolbar {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Share state 0' }))

    mocks.folded = new Set(['share'])
    view.rerender(<BrowserChromeToolbar {...props} />)

    expect(screen.getByRole('button', { name: 'Share state 1' })).not.toBeNull()
  })
})
