import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolvePaneColumnEdgeZone, TAB_GROUP_TAB_STRIP_HEIGHT_PX } from './tab-drop-zone'

describe('tab strip drop boundary', () => {
  // Why: the constant is the *only* link between the rendered tab row and pane
  // split hit-testing — every other test references it symbolically, so a
  // desync between the two leaves drops resolving against a stale offset.
  it('matches the tab row height rendered by TabGroupPanel', () => {
    const panelSource = readFileSync(join(__dirname, 'TabGroupPanel.tsx'), 'utf8')

    expect(panelSource).toContain(`h-[${TAB_GROUP_TAB_STRIP_HEIGHT_PX}px] shrink-0 border-b`)
  })

  // Why: the tab row alone now spans the full top band that `titlebar-left`
  // sets beside it. A spacer creeping back above the panes would reopen the gap.
  it('spans the full titlebar-left band so panes stay flush to the top', () => {
    const mainCss = readFileSync(join(__dirname, '../../assets/main.css'), 'utf8')
    const titlebarLeftHeight = /\.titlebar-left\s*{[^}]*height:\s*(\d+)px/s.exec(mainCss)?.[1]

    expect(titlebarLeftHeight).toBe(String(TAB_GROUP_TAB_STRIP_HEIGHT_PX))
  })
})

describe('resolvePaneColumnEdgeZone', () => {
  const panelRect = { left: 0, top: 0, width: 300, height: 200 }

  it('returns right on the outer horizontal band in the body', () => {
    expect(resolvePaneColumnEdgeZone(panelRect, { x: 260, y: 100 })).toBe('right')
  })

  it('returns null in the center band of the body', () => {
    expect(resolvePaneColumnEdgeZone(panelRect, { x: 150, y: 100 })).toBeNull()
  })

  it('does not return up while the pointer is still in the tab strip', () => {
    expect(
      resolvePaneColumnEdgeZone(panelRect, {
        x: 150,
        y: TAB_GROUP_TAB_STRIP_HEIGHT_PX - 1
      })
    ).toBeNull()
  })

  it('returns up on the top edge of the pane body', () => {
    expect(
      resolvePaneColumnEdgeZone(panelRect, {
        x: 150,
        y: TAB_GROUP_TAB_STRIP_HEIGHT_PX + 5
      })
    ).toBe('up')
  })
})
