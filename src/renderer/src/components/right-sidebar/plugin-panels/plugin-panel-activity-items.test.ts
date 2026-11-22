// @vitest-environment happy-dom

import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { pluginPanelAccessibleTitle, resolvePluginPanelIcon } from './plugin-panel-activity-items'

afterEach(cleanup)

function renderIcon(iconName: string | undefined, iconPath?: unknown) {
  const Icon = resolvePluginPanelIcon(iconName, iconPath)
  return render(createElement(Icon, { size: 18 })).container
}

it('uses the system text color for path icons in forced colors', () => {
  const stylesheet = readFileSync('src/renderer/src/assets/main.css', 'utf8')
  expect(stylesheet).toMatch(
    /@media\s*\(forced-colors:\s*active\)\s*\{\s*\.plugin-panel-icon\s*\{\s*color:\s*CanvasText\s*;/
  )
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
