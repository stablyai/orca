import { describe, expect, it } from 'vitest'
import { resolveDuplicateTerminalLayoutBindings } from './workspace-terminal-layout-duplicate-bindings'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../../shared/terminal-tab-types'

const SPLIT_TAB = 'tab-split'
const SINGLE_TAB = 'tab-single'
// Why real UUIDs: layout normalization re-mints any leaf id that is not a stable pane id.
const SHARED_LEAF = '10cb5648-8a54-41c0-a6a4-ef0028d93599'
const OTHER_LEAF = 'df8913c9-fd8a-420a-a7d6-17daf0ed30f0'
const ELSEWHERE_LEAF = '96cdf7ea-9c83-4ba5-a41b-c425955e6606'
const SHARED_PTY = 'wt-1@@shared'

function tab(id: string, sortOrder: number, createdAt = 1_000 + sortOrder): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder,
    createdAt
  }
}

function heal(
  layoutsByTabId: Record<string, TerminalLayoutSnapshot>,
  tabs: TerminalTab[],
  canonicalTabIds: string[] = []
): Record<string, TerminalLayoutSnapshot> {
  return resolveDuplicateTerminalLayoutBindings({
    canonicalTabIds: new Set(canonicalTabIds),
    layoutsByTabId,
    tabById: new Map(tabs.map((row) => [row.id, row]))
  }).layoutsByTabId
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: OTHER_LEAF },
      second: { type: 'leaf', leafId: SHARED_LEAF }
    },
    activeLeafId: SHARED_LEAF,
    expandedLeafId: null,
    ptyIdsByLeafId: { [OTHER_LEAF]: 'wt-1@@other', [SHARED_LEAF]: SHARED_PTY }
  }
}

function singleLeafLayout(leafId: string, ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

describe('resolveDuplicateTerminalLayoutBindings', () => {
  it('leaves the single-leaf loser its pane and takes only the pty binding', () => {
    const healed = heal(
      {
        [SPLIT_TAB]: splitLayout(),
        [SINGLE_TAB]: singleLeafLayout(SHARED_LEAF, SHARED_PTY)
      },
      [tab(SPLIT_TAB, 0), tab(SINGLE_TAB, 1)]
    )

    expect(healed[SPLIT_TAB].ptyIdsByLeafId?.[SHARED_LEAF]).toBe(SHARED_PTY)
    expect(healed[SINGLE_TAB].root).toEqual({ type: 'leaf', leafId: SHARED_LEAF })
    expect(healed[SINGLE_TAB].ptyIdsByLeafId ?? {}).toEqual({})
    expect(healed[SINGLE_TAB].activeLeafId).toBe(SHARED_LEAF)
  })

  it('removes the duplicated leaf from a split loser and keeps its other panes', () => {
    const healed = heal(
      {
        [SPLIT_TAB]: splitLayout(),
        [SINGLE_TAB]: singleLeafLayout(SHARED_LEAF, SHARED_PTY)
      },
      [tab(SINGLE_TAB, 0), tab(SPLIT_TAB, 1)]
    )

    expect(healed[SPLIT_TAB].root).toEqual({ type: 'leaf', leafId: OTHER_LEAF })
    expect(healed[SPLIT_TAB].ptyIdsByLeafId).toEqual({ [OTHER_LEAF]: 'wt-1@@other' })
    expect(healed[SPLIT_TAB].activeLeafId).toBe(OTHER_LEAF)
    expect(healed[SINGLE_TAB].ptyIdsByLeafId?.[SHARED_LEAF]).toBe(SHARED_PTY)
  })

  it('unbinds a pty shared under two leaf ids and leaves both panes standing', () => {
    const healed = heal(
      {
        [SPLIT_TAB]: splitLayout(),
        [SINGLE_TAB]: singleLeafLayout(ELSEWHERE_LEAF, SHARED_PTY)
      },
      [tab(SINGLE_TAB, 0), tab(SPLIT_TAB, 1)]
    )

    const owners = Object.entries(healed)
      .filter(([, layout]) => Object.values(layout.ptyIdsByLeafId ?? {}).includes(SHARED_PTY))
      .map(([tabId]) => tabId)
    expect(owners).toEqual([SINGLE_TAB])
    // The losing pane is real — only its mount collided — so the split keeps both leaves.
    expect(healed[SPLIT_TAB].root).toEqual(splitLayout().root)
    expect(healed[SPLIT_TAB].ptyIdsByLeafId).toEqual({ [OTHER_LEAF]: 'wt-1@@other' })
    expect(healed[SPLIT_TAB].activeLeafId).toBe(OTHER_LEAF)
  })

  it('lets a canonical unified tab outrank a lower sort order', () => {
    const healed = heal(
      {
        [SPLIT_TAB]: splitLayout(),
        [SINGLE_TAB]: singleLeafLayout(SHARED_LEAF, SHARED_PTY)
      },
      [tab(SPLIT_TAB, 0), tab(SINGLE_TAB, 1)],
      [SINGLE_TAB]
    )

    expect(healed[SINGLE_TAB].ptyIdsByLeafId?.[SHARED_LEAF]).toBe(SHARED_PTY)
    expect(healed[SPLIT_TAB].root).toEqual({ type: 'leaf', leafId: OTHER_LEAF })
  })

  it('breaks an all-equal tie on tab id, whichever order the layouts arrive in', () => {
    const tabs = [tab('tab-b', 0, 1_000), tab('tab-a', 0, 1_000)]
    const forward = heal(
      {
        'tab-b': singleLeafLayout(SHARED_LEAF, SHARED_PTY),
        'tab-a': singleLeafLayout(SHARED_LEAF, SHARED_PTY)
      },
      tabs
    )
    const reverse = heal(
      {
        'tab-a': singleLeafLayout(SHARED_LEAF, SHARED_PTY),
        'tab-b': singleLeafLayout(SHARED_LEAF, SHARED_PTY)
      },
      tabs
    )

    for (const healed of [forward, reverse]) {
      expect(healed['tab-a'].ptyIdsByLeafId?.[SHARED_LEAF]).toBe(SHARED_PTY)
      expect(healed['tab-b'].ptyIdsByLeafId ?? {}).toEqual({})
    }
  })

  it('ignores a binding whose pane already left the tree', () => {
    const ghost: TerminalLayoutSnapshot = {
      root: null,
      activeLeafId: null,
      expandedLeafId: null,
      ptyIdsByLeafId: { [ELSEWHERE_LEAF]: SHARED_PTY }
    }
    const healed = heal({ [SINGLE_TAB]: ghost, [SPLIT_TAB]: splitLayout() }, [
      tab(SINGLE_TAB, 0),
      tab(SPLIT_TAB, 1)
    ])

    // The ghost reattaches nothing, so it must not outrank the pane that still mounts the pty.
    expect(healed[SPLIT_TAB].ptyIdsByLeafId?.[SHARED_LEAF]).toBe(SHARED_PTY)
  })

  it('returns the same object, and surrenders nothing, when no tab collides', () => {
    const layoutsByTabId = {
      [SPLIT_TAB]: splitLayout(),
      [SINGLE_TAB]: singleLeafLayout('08d0d524-0d46-410b-ba08-b43c97a2b4e4', 'wt-1@@own')
    }

    const resolution = resolveDuplicateTerminalLayoutBindings({
      canonicalTabIds: new Set<string>(),
      layoutsByTabId,
      tabById: new Map([tab(SPLIT_TAB, 0), tab(SINGLE_TAB, 1)].map((row) => [row.id, row]))
    })

    expect(resolution.layoutsByTabId).toBe(layoutsByTabId)
    expect(resolution.surrenderedPtyIdsByTabId.size).toBe(0)
  })

  it('names the pty each losing tab gave up, whichever shape it lost it in', () => {
    const resolution = resolveDuplicateTerminalLayoutBindings({
      canonicalTabIds: new Set<string>(),
      layoutsByTabId: {
        [SPLIT_TAB]: splitLayout(),
        [SINGLE_TAB]: singleLeafLayout(SHARED_LEAF, SHARED_PTY)
      },
      tabById: new Map([tab(SPLIT_TAB, 0), tab(SINGLE_TAB, 1)].map((row) => [row.id, row]))
    })

    expect([...(resolution.surrenderedPtyIdsByTabId.get(SINGLE_TAB) ?? [])]).toEqual([SHARED_PTY])
    expect(resolution.surrenderedPtyIdsByTabId.has(SPLIT_TAB)).toBe(false)
  })
})
