// @vitest-environment happy-dom

import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ActivePluginPanel } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActivityBarItem } from '../activity-bar/activity-bar-buttons'
import { activityBarDragName } from '../activity-bar/activity-bar-drag-announcements'
import { activityItemAriaLabel } from '../activity-bar/activity-bar-item-names'
import {
  builtInTabNames,
  getPluginPanelActivityItems,
  pluginPanelAccessibleTitle,
  resolvePluginPanelIcon,
  withDistinctPluginPanelNames
} from './plugin-panel-activity-items'

afterEach(cleanup)

function renderIcon(iconName: string | undefined, iconPath?: unknown) {
  const Icon = resolvePluginPanelIcon(iconName, iconPath)
  return render(createElement(Icon, { size: 18 })).container
}

type CssBlock = { prelude: string; body: string; parents: string[] }

/** Every `prelude { body }` block in the stylesheet, comments removed, with the preludes of the
 *  blocks around it, outermost first. */
function cssBlocks(css: string): CssBlock[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const blocks: CssBlock[] = []
  const open: { prelude: string; start: number }[] = []
  let preludeStart = 0
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (char === '{') {
      open.push({ prelude: source.slice(preludeStart, index).trim(), start: index + 1 })
      preludeStart = index + 1
    } else if (char === '}') {
      const block = open.pop()
      if (block) {
        blocks.push({
          prelude: block.prelude,
          body: source.slice(block.start, index),
          parents: open.map((parent) => parent.prelude)
        })
      }
      preludeStart = index + 1
    } else if (char === ';') {
      preludeStart = index + 1
    }
  }
  return blocks
}

function declarations(body: string): Record<string, string> {
  return Object.fromEntries(
    body
      .split(';')
      .map((part) => part.split(':').map((side) => side.trim()))
      .filter((pair): pair is [string, string] => pair.length === 2 && pair[0] !== '')
  )
}

it('uses the system text color for path icons in forced colors', () => {
  const blocks = cssBlocks(readFileSync('src/renderer/src/assets/main.css', 'utf8'))
  const iconRules = blocks.filter(
    (block) => !block.prelude.startsWith('@') && block.prelude.includes('.plugin-panel-icon')
  )
  // Why exact: one rule, directly in a top-level forced-colors query, sets only the color, and
  // no other rule anywhere in the stylesheet styles the icon.
  expect(iconRules).toHaveLength(1)
  const [rule] = iconRules
  expect(rule?.prelude).toBe('.plugin-panel-icon')
  expect(rule?.parents).toHaveLength(1)
  expect(rule?.parents[0]).toMatch(/^@media\s*\(\s*forced-colors\s*:\s*active\s*\)$/)
  expect(declarations(rule?.body ?? '')).toEqual({ color: 'CanvasText' })

  // The rule only takes effect when the icon opts out of forced colors and draws in currentColor.
  for (const mode of ['stroke', 'fill']) {
    const svg = renderIcon(undefined, { path: 'M4 4h16v16H4z', mode }).querySelector('svg')
    expect(svg?.classList.contains('plugin-panel-icon')).toBe(true)
    expect(svg?.getAttribute('style')).toMatch(/forced-color-adjust:\s*none/)
    expect(svg?.getAttribute(mode)).toBe('currentColor')
    cleanup()
  }
})

it('draws a stroke path icon with Lucide-style attributes', () => {
  const svg = renderIcon(undefined, {
    path: 'M4 4h16v16H4z',
    viewBox: '0 0 24 24',
    mode: 'stroke'
  }).querySelector('svg')
  expect(svg?.getAttribute('viewBox')).toBe('0 0 24 24')
  expect(svg?.getAttribute('fill')).toBe('none')
  expect(svg?.getAttribute('stroke')).toBe('currentColor')
  expect(svg?.getAttribute('stroke-width')).toBe('2')
  expect(svg?.getAttribute('stroke-linecap')).toBe('round')
  expect(svg?.getAttribute('class')).toContain('plugin-panel-icon')
  expect(svg?.querySelector('path')?.getAttribute('d')).toBe('M4 4h16v16H4z')
})

it('draws a fill path icon in the theme color', () => {
  const svg = renderIcon(undefined, {
    path: 'M2 2h20v20H2z',
    viewBox: '0 0 48 48',
    mode: 'fill'
  }).querySelector('svg')
  expect(svg?.getAttribute('viewBox')).toBe('0 0 48 48')
  expect(svg?.getAttribute('fill')).toBe('currentColor')
  expect(svg?.getAttribute('stroke')).toBe('none')
})

it('reuses one component per path icon', () => {
  const icon = { path: 'M1 1h2', viewBox: '0 0 24 24', mode: 'stroke' }
  expect(resolvePluginPanelIcon(undefined, icon)).toBe(
    resolvePluginPanelIcon(undefined, { ...icon })
  )
})

it('falls back to the built-in glyph or puzzle when a host sends an invalid path icon', () => {
  const puzzle = renderIcon(undefined).innerHTML
  expect(renderIcon(undefined, { path: 'M0 0"/><script/>' }).innerHTML).toBe(puzzle)
  expect(renderIcon(undefined, 'M0 0').innerHTML).toBe(puzzle)
  expect(renderIcon(undefined, { path: 'M1. 2.L-.5-1.5' }).innerHTML).toBe(puzzle)
  expect(renderIcon(undefined, { path: 'M0 0L1e39 1' }).innerHTML).toBe(puzzle)
  expect(
    renderIcon(undefined, { path: 'M2 2H340282350000000000000000000000000000000e-38M8 8h8' })
      .innerHTML
  ).toBe(puzzle)
  expect(renderIcon('database', { path: 'nope' }).innerHTML).toBe(renderIcon('database').innerHTML)
  expect(renderIcon('database').innerHTML).not.toBe(puzzle)
})

it('keeps recently used path icons when the cache evicts', () => {
  const keep = { path: 'M0 0h1', viewBox: '0 0 24 24', mode: 'stroke' }
  const Kept = resolvePluginPanelIcon(undefined, keep)
  for (let index = 0; index < 300; index++) {
    resolvePluginPanelIcon(undefined, { path: `M0 0h${index + 2}` })
    resolvePluginPanelIcon(undefined, keep)
  }
  expect(resolvePluginPanelIcon(undefined, keep)).toBe(Kept)
})

it('names the plugin in the accessible title unless the title already does', () => {
  expect(pluginPanelAccessibleTitle('Acme', 'Dashboard')).toBe('Acme: Dashboard')
  expect(pluginPanelAccessibleTitle('Acme', 'acme')).toBe('acme')
  expect(pluginPanelAccessibleTitle('Acme', 'Acme: Dashboard')).toBe('Acme: Dashboard')
  expect(pluginPanelAccessibleTitle('Acme', 'Acme - Dashboard')).toBe('Acme - Dashboard')
  // Why: a substring or bare prefix is another name, so the plugin must still be named.
  expect(pluginPanelAccessibleTitle('Git', 'GitHub')).toBe('Git: GitHub')
  expect(pluginPanelAccessibleTitle('Hub', 'GitHub Hub')).toBe('Hub: GitHub Hub')
  expect(pluginPanelAccessibleTitle('Acme', 'Acme Dashboard')).toBe('Acme: Acme Dashboard')
})

function panel(
  pluginKey: string,
  pluginName: string,
  id: string,
  title: string
): ActivePluginPanel {
  return { id, title, pluginKey, pluginName, tabKey: `plugin:${pluginKey}/${id}` }
}

function spokenNames(items: ActivityBarItem[]): string[] {
  return items.map((item) => item.accessibleTitle ?? item.title)
}

it('names colliding plugin panels apart and leaves distinct ones alone', () => {
  const distinct = getPluginPanelActivityItems([
    panel('acme/db', 'Acme', 'main', 'Dashboard'),
    panel('beta/db', 'Beta', 'main', 'Dashboard')
  ])
  expect(withDistinctPluginPanelNames(distinct)).toBe(distinct)

  // Two plugins that share a display name and panel title.
  const twins = withDistinctPluginPanelNames(
    getPluginPanelActivityItems([
      panel('acme/db', 'Acme', 'main', 'Dashboard'),
      panel('acme-fork/db', 'Acme', 'main', 'Dashboard')
    ])
  )
  expect(spokenNames(twins)).toEqual([
    'Acme: Dashboard (acme/db)',
    'Acme: Dashboard (acme-fork/db)'
  ])

  // One plugin with two panels of the same title needs the panel too.
  const sameTitle = withDistinctPluginPanelNames(
    getPluginPanelActivityItems([
      panel('acme/db', 'Acme', 'main', 'Dashboard'),
      panel('acme/db', 'Acme', 'alt', 'dashboard')
    ])
  )
  expect(spokenNames(sameTitle)).toEqual([
    'Acme: Dashboard (acme/db/main)',
    'Acme: dashboard (acme/db/alt)'
  ])
  expect(sameTitle.map((item) => item.title)).toEqual(['Dashboard', 'dashboard'])

  const existingLabel = withDistinctPluginPanelNames(
    getPluginPanelActivityItems([
      panel('acme/db', 'Acme', 'main', 'Dashboard'),
      panel('acme/db', 'Acme', 'alt', 'Dashboard'),
      panel('beta/db', 'Acme', 'main', 'Dashboard (acme/db/main)')
    ])
  )
  expect(spokenNames(existingLabel)).toEqual([
    'Acme: Dashboard (acme/db/main) (2)',
    'Acme: Dashboard (acme/db/alt)',
    'Acme: Dashboard (acme/db/main)'
  ])
})

it('keeps built-in tab names and renames a plugin panel that copies one', () => {
  const builtIn: ActivityBarItem = {
    id: 'explorer',
    icon: () => null,
    title: 'Explorer',
    shortcut: ''
  }
  const [copy] = getPluginPanelActivityItems([
    panel('acme/explorer', 'Explorer', 'main', 'Explorer')
  ])
  if (!copy) {
    throw new Error('expected a plugin panel item')
  }
  const items = withDistinctPluginPanelNames([builtIn, copy])
  expect(items[0]).toBe(builtIn)
  expect(spokenNames(items)).toEqual(['Explorer', 'Explorer (acme/explorer)'])
})

it('tells tabs apart whose labels differ only by case or spacing', () => {
  const sameOwner = withDistinctPluginPanelNames(
    getPluginPanelActivityItems([
      panel('ops', 'Ops', 'main', 'Job Log'),
      panel('ops', 'Ops', 'alt', 'Job  Log')
    ])
  )
  expect(spokenNames(sameOwner)).toEqual(['Ops: Job Log (ops/main)', 'Ops: Job  Log (ops/alt)'])
  // Same-plugin twins need the panel path too; the tooltip and visible title keep the plugin's text.
  expect(sameOwner.map((item) => item.title)).toEqual(['Job Log', 'Job  Log'])

  const twoPlugins = withDistinctPluginPanelNames(
    getPluginPanelActivityItems([
      panel('ops-a', 'Ops', 'main', 'Job Log'),
      panel('ops-b', 'Ops', 'main', 'job  LOG')
    ])
  )
  expect(spokenNames(twoPlugins)).toEqual(['Ops: Job Log (ops-a)', 'Ops: job  LOG (ops-b)'])

  // A failing tab keeps its distinct name; the error word is added after the name.
  const failing = withDistinctPluginPanelNames(
    getPluginPanelActivityItems(
      [panel('ops', 'Ops', 'main', 'Job Log'), panel('ops', 'Ops', 'alt', 'Job  Log')],
      { 'plugin:ops/alt': true }
    )
  )
  expect(failing[1]?.statusIndicator).toBe('failure')
  expect(spokenNames(failing)).toEqual(['Ops: Job Log (ops/main)', 'Ops: Job  Log (ops/alt)'])
})

it('never lets a plugin tab read as exactly a built-in tab name', () => {
  const builtIn: ActivityBarItem = {
    id: 'explorer',
    icon: () => null,
    title: 'Explorer',
    shortcut: '⌘⇧E'
  }
  // The built-in tab announces and shows its shortcut hint, so that is its final name.
  const builtInNames = builtInTabNames([builtIn])
  expect(builtInNames).toEqual(new Set(['explorer (⌘⇧e)']))
  // A plugin named with the shortcut hint and titled the same would read as the built-in tab.
  expect(pluginPanelAccessibleTitle('Explorer (⌘⇧E)', 'Explorer (⌘⇧E)', builtInNames)).toBe(
    'Explorer (⌘⇧E): Explorer (⌘⇧E)'
  )
  // Without the hint the names differ, so nothing is prefixed.
  expect(pluginPanelAccessibleTitle('Explorer', 'Explorer', builtInNames)).toBe('Explorer')
  expect(pluginPanelAccessibleTitle('Acme', 'EXPLORER (⌘⇧E)', builtInNames)).toBe(
    'Acme: EXPLORER (⌘⇧E)'
  )
  expect(pluginPanelAccessibleTitle('Explorer (⌘⇧E)', 'Explorer (⌘⇧E)', new Set())).toBe(
    'Explorer (⌘⇧E)'
  )

  const [copy] = getPluginPanelActivityItems(
    [panel('explorer-app', 'Explorer (⌘⇧E)', 'main', 'Explorer (⌘⇧E)')],
    {},
    builtInNames
  )
  if (!copy) {
    throw new Error('expected a plugin panel item')
  }
  const items = withDistinctPluginPanelNames([builtIn, copy])
  expect(items[0]).toBe(builtIn)
  expect(spokenNames(items)).toEqual(['Explorer', 'Explorer (⌘⇧E): Explorer (⌘⇧E)'])

  // Even without the built-in names, the collision is caught on the tooltip the tab shows.
  const [unnamed] = getPluginPanelActivityItems([
    panel('explorer-app', 'Explorer (⌘⇧E)', 'main', 'Explorer (⌘⇧E)')
  ])
  if (!unnamed) {
    throw new Error('expected a plugin panel item')
  }
  expect(spokenNames(withDistinctPluginPanelNames([builtIn, unnamed]))).toEqual([
    'Explorer',
    'Explorer (⌘⇧E) (explorer-app)'
  ])
})

it('judges a plugin tab against the count a built-in tab announces', () => {
  // Home announces its count, so its accessible name is "Home, 1 needs you", not its tooltip.
  const home: ActivityBarItem = {
    id: 'bot-activity',
    icon: () => null,
    title: 'Home',
    shortcut: '',
    count: 1,
    countLabel: '1 needs you'
  }
  expect(activityItemAriaLabel(home)).toBe('Home, 1 needs you')
  const plugin = () =>
    getPluginPanelActivityItems([
      panel('acme/home', 'Home, 1 needs you', 'main', 'Home, 1 needs you')
    ])

  // Visible together: the plugin tab gives way, and the built-in tab keeps its name.
  const items = withDistinctPluginPanelNames([home, ...plugin()])
  expect(items[0]).toBe(home)
  expect(items.map((item) => activityItemAriaLabel(item))).toEqual([
    'Home, 1 needs you',
    'Home, 1 needs you (acme/home)'
  ])

  // Checked against every built-in label, even when the built-in tab is not shown.
  const builtInNames = builtInTabNames([home])
  expect(builtInNames.has('home, 1 needs you')).toBe(true)
  expect(
    getPluginPanelActivityItems(
      [panel('acme/home', 'Home, 1 needs you', 'main', 'Home, 1 needs you')],
      {},
      builtInNames
    )[0]?.accessibleTitle
  ).toBe('Home, 1 needs you: Home, 1 needs you')
})

it('judges collisions on the final announced names, status words included', () => {
  // A failing "Jobs" tab is announced "Ops: Jobs — Error"; a healthy tab titled "Jobs — Error"
  // is announced the same, so neither name may stand alone.
  const items = withDistinctPluginPanelNames(
    getPluginPanelActivityItems(
      [panel('ops-a', 'Ops', 'main', 'Jobs'), panel('ops-b', 'Ops', 'main', 'Jobs — Error')],
      { 'plugin:ops-a/main': true }
    )
  )
  expect(spokenNames(items)).toEqual(['Ops: Jobs (ops-a)', 'Ops: Jobs — Error (ops-b)'])
  const announced = items.map((item) =>
    item.statusIndicator === 'failure'
      ? `${item.accessibleTitle} — Error`
      : (item.accessibleTitle ?? item.title)
  )
  expect(new Set(announced).size).toBe(announced.length)
  // The tooltips differ too, so a hovered tab never shows another tab's text.
  expect(new Set(items.map((item) => item.accessibleTitle)).size).toBe(items.length)
})

it('keeps a status-tagged tab distinct from a built-in tab with the same status word', () => {
  const checks: ActivityBarItem = { id: 'checks', icon: () => null, title: 'Checks', shortcut: '' }
  const [plugin] = getPluginPanelActivityItems([
    panel('acme/checks', 'Checks', 'main', 'Checks — Error')
  ])
  if (!plugin) {
    throw new Error('expected a plugin panel item')
  }
  // The checks tab announces its own failure, which the plugin tab's name must not match.
  const items = withDistinctPluginPanelNames([checks, plugin], (item) =>
    item.id === 'checks' ? 'failure' : item.statusIndicator
  )
  expect(spokenNames(items)).toEqual(['Checks', 'Checks — Error (acme/checks)'])
})

it('names a plugin by its id when its display name is blank', () => {
  expect(
    getPluginPanelActivityItems([panel('acme/db', '   ', 'main', 'Dashboard')])[0]?.accessibleTitle
  ).toBe('acme/db: Dashboard')
  expect(
    getPluginPanelActivityItems([panel('acme/db', '\t', 'main', 'Dashboard')])[0]?.accessibleTitle
  ).toBe('acme/db: Dashboard')
  // A padded display name names the plugin by its trimmed text.
  expect(
    getPluginPanelActivityItems([panel('acme/db', '  Acme  ', 'main', 'Dashboard')])[0]
      ?.accessibleTitle
  ).toBe('Acme: Dashboard')
})

it('announces a dragged plugin panel by its distinct name', () => {
  const items = withDistinctPluginPanelNames(
    getPluginPanelActivityItems([
      panel('acme/db', 'Acme', 'main', 'Dashboard'),
      panel('acme-fork/db', 'Acme', 'main', 'Dashboard')
    ])
  )
  expect(activityBarDragName(items, 'plugin:acme/db/main')).toBe('Acme: Dashboard (acme/db)')
  expect(activityBarDragName(items, 'plugin:acme-fork/db/main')).toBe(
    'Acme: Dashboard (acme-fork/db)'
  )
  expect(activityBarDragName(items, 'missing')).toBe('')
})
