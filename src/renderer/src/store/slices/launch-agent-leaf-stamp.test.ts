import { describe, expect, it } from 'vitest'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'
import { emptyLayoutSnapshot, singlePaneLayoutSnapshot } from './terminal-helpers'
import {
  resolveLaunchAgentLeafId,
  stampLaunchAgentLeafIdOnFirstLayout,
  transferLaunchAgentLeafStampOnDetach
} from './launch-agent-leaf-stamp'

const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'tab-1',
    worktreeId: 'wt-1',
    ptyId: null,
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  }
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_A },
      second: { type: 'leaf', leafId: LEAF_B }
    },
    activeLeafId: LEAF_A,
    expandedLeafId: null
  }
}

describe('stampLaunchAgentLeafIdOnFirstLayout', () => {
  it('pins launch provenance to the first sole leaf', () => {
    const stamped = stampLaunchAgentLeafIdOnFirstLayout({
      tabs: [makeTab({ launchAgent: 'cursor' })],
      tabId: 'tab-1',
      previousLayout: emptyLayoutSnapshot(),
      nextLayout: singlePaneLayoutSnapshot(LEAF_A)
    })

    expect(stamped?.[0]?.launchAgentLeafId).toBe(LEAF_A)
  })

  it('does not overwrite a stamp after the original leaf closes', () => {
    const stamped = stampLaunchAgentLeafIdOnFirstLayout({
      tabs: [makeTab({ launchAgent: 'cursor', launchAgentLeafId: LEAF_A })],
      tabId: 'tab-1',
      previousLayout: splitLayout(),
      nextLayout: singlePaneLayoutSnapshot(LEAF_B)
    })

    expect(stamped).toBeNull()
  })

  it('does not stamp a split as the original leaf', () => {
    const stamped = stampLaunchAgentLeafIdOnFirstLayout({
      tabs: [makeTab({ launchAgent: 'cursor' })],
      tabId: 'tab-1',
      previousLayout: emptyLayoutSnapshot(),
      nextLayout: splitLayout()
    })

    expect(stamped).toBeNull()
  })

  it('does not stamp a tab with no launch identity', () => {
    const stamped = stampLaunchAgentLeafIdOnFirstLayout({
      tabs: [makeTab()],
      tabId: 'tab-1',
      previousLayout: emptyLayoutSnapshot(),
      nextLayout: singlePaneLayoutSnapshot(LEAF_A)
    })

    expect(stamped).toBeNull()
  })
})

describe('resolveLaunchAgentLeafId', () => {
  it('stamps the first sole leaf while launch identity is live', () => {
    expect(
      resolveLaunchAgentLeafId({
        launchAgent: 'cursor',
        existingLeafId: undefined,
        previousLayout: emptyLayoutSnapshot(),
        nextLayout: singlePaneLayoutSnapshot(LEAF_A)
      })
    ).toBe(LEAF_A)
  })

  it('keeps the original pin after a remaining sibling becomes the sole leaf', () => {
    expect(
      resolveLaunchAgentLeafId({
        launchAgent: 'cursor',
        existingLeafId: LEAF_A,
        previousLayout: splitLayout(),
        nextLayout: singlePaneLayoutSnapshot(LEAF_B)
      })
    ).toBe(LEAF_A)
  })

  it('drops the pin when launch identity is gone', () => {
    expect(
      resolveLaunchAgentLeafId({
        launchAgent: undefined,
        existingLeafId: LEAF_A,
        previousLayout: singlePaneLayoutSnapshot(LEAF_A),
        nextLayout: singlePaneLayoutSnapshot(LEAF_A)
      })
    ).toBeUndefined()
  })
})

describe('transferLaunchAgentLeafStampOnDetach', () => {
  it('moves launch provenance with the detached leaf', () => {
    const tabs = transferLaunchAgentLeafStampOnDetach({
      tabs: [
        makeTab({ id: 'source', launchAgent: 'cursor', launchAgentLeafId: LEAF_A }),
        makeTab({ id: 'target' })
      ],
      sourceTabId: 'source',
      targetTabId: 'target',
      detachedLeafId: LEAF_A
    })

    expect(tabs?.find((tab) => tab.id === 'source')).not.toHaveProperty('launchAgent')
    expect(tabs?.find((tab) => tab.id === 'source')).not.toHaveProperty('launchAgentLeafId')
    expect(tabs?.find((tab) => tab.id === 'target')).toMatchObject({
      launchAgent: 'cursor',
      launchAgentLeafId: LEAF_A
    })
  })

  it('does not overwrite existing target launch provenance', () => {
    expect(
      transferLaunchAgentLeafStampOnDetach({
        tabs: [
          makeTab({ id: 'source', launchAgent: 'cursor', launchAgentLeafId: LEAF_A }),
          makeTab({ id: 'target', launchAgent: 'codex', launchAgentLeafId: LEAF_B })
        ],
        sourceTabId: 'source',
        targetTabId: 'target',
        detachedLeafId: LEAF_A
      })
    ).toBeNull()
  })

  it('does not guess ownership for an unpinned launch', () => {
    expect(
      transferLaunchAgentLeafStampOnDetach({
        tabs: [makeTab({ id: 'source', launchAgent: 'cursor' }), makeTab({ id: 'target' })],
        sourceTabId: 'source',
        targetTabId: 'target',
        detachedLeafId: LEAF_A
      })
    ).toBeNull()
  })
})
