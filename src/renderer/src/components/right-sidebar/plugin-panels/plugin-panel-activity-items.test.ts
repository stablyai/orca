// @vitest-environment happy-dom

import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ActivePluginPanel } from '@/store/plugins/catalog/plugin-contribution-catalog'
import type { ActivityBarItem } from '../activity-bar/activity-bar-buttons'
import { activityBarDragName } from '../activity-bar/activity-bar-drag-announcements'
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
    title: 'Files',
    shortcut: '⌘⇧E'
  }
  const builtInNames = builtInTabNames([builtIn])
  expect(builtInNames).toEqual(new Set(['files']))
  // A plugin named Files with a title of Files would otherwise read as the built-in tab.
  expect(pluginPanelAccessibleTitle('Files', 'Files', builtInNames)).toBe('Files: Files')
  expect(pluginPanelAccessibleTitle('Acme', 'FILES', builtInNames)).toBe('Acme: FILES')
  expect(pluginPanelAccessibleTitle('Files', 'Files', new Set())).toBe('Files')

  const [copy] = getPluginPanelActivityItems(
    [panel('files-app', 'Files', 'main', 'Files')],
    {},
    builtInNames
  )
  if (!copy) {
    throw new Error('expected a plugin panel item')
  }
  const items = withDistinctPluginPanelNames([builtIn, copy])
  expect(items[0]).toBe(builtIn)
  expect(spokenNames(items)).toEqual(['Files', 'Files: Files'])
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
