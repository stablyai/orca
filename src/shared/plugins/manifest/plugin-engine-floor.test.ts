import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { pluginPanelContributionSchema } from '../contributions/plugin-panel-contribution'
import { pluginEngineFloor } from './plugin-engine-floor'
import {
  PLUGIN_PANEL_PATH_ICON_SINCE,
  PLUGIN_PANEL_UI_SINCE,
  PLUGIN_SCHEMA_SINCE_V1
} from './plugin-schema-field-docs'

const since = (version: string) => ({ 'x-orca-since': version })

// Why synthetic: each option and field carries its own release, so the floor shows which
// option the walk took.
const icon = z.union([
  z.enum(['old', 'shared']).meta(since('1.0.0')),
  z.enum(['shared', 'newer']).meta(since('3.0.0')),
  z
    .strictObject({
      path: z.string(),
      mode: z.enum(['stroke', 'fill']).optional().meta(since('5.0.0'))
    })
    .meta(since('4.0.0'))
])
const schema = z.object({
  name: z.string().meta(since('0.1.0')),
  panels: z.array(z.object({ icon: icon.optional() })).optional()
})

function floorOf(panels: unknown[]) {
  return pluginEngineFloor(schema, { name: 'x', panels })
}

describe('pluginEngineFloor through a union', () => {
  it('walks only the option the value matches', () => {
    expect(floorOf([{ icon: 'old' }])).toEqual({ version: '1.0.0', field: 'panels[0].icon' })
    expect(floorOf([{ icon: 'newer' }])).toEqual({ version: '3.0.0', field: 'panels[0].icon' })
    expect(floorOf([{ icon: { path: 'M0 0' } }])).toEqual({
      version: '4.0.0',
      field: 'panels[0].icon'
    })
  })

  it('takes the first matching option when several match', () => {
    expect(floorOf([{ icon: 'shared' }])).toEqual({ version: '1.0.0', field: 'panels[0].icon' })
  })

  it('descends into the matched option, so its own fields raise the floor', () => {
    expect(floorOf([{ icon: { path: 'M0 0', mode: 'fill' } }])).toEqual({
      version: '5.0.0',
      field: 'panels[0].icon.mode'
    })
  })

  it('adds nothing for a value no option matches', () => {
    expect(floorOf([{ icon: { path: 'M0 0', color: 'red' } }])).toEqual({
      version: '0.1.0',
      field: 'name'
    })
    expect(floorOf([{ icon: 42 }])).toEqual({ version: '0.1.0', field: 'name' })
  })

  it('reports the newest panel across the array, at its index', () => {
    expect(floorOf([{ icon: 'old' }, { icon: { path: 'M0 0' } }, { icon: 'newer' }])).toEqual({
      version: '4.0.0',
      field: 'panels[1].icon'
    })
  })
})

describe('pluginEngineFloor for real panel icons', () => {
  const floor = (value: unknown) =>
    pluginEngineFloor(pluginPanelContributionSchema, { icon: value })

  it('sets the path icon floor past the published v1.4.273, which rejects path icon manifests', () => {
    // Why pinned: v1.4.273 is the latest published release and rejects a format-2 path-icon
    // manifest outright. An older client can also show the `puzzle` fallback for a panel that a
    // newer host accepts. Re-check this value when the release that carries path icons ships.
    expect(PLUGIN_PANEL_PATH_ICON_SINCE).toBe('1.4.274')
  })

  it('needs the path icon release only for a path icon', () => {
    expect(floor({ path: 'M4 4h16v16H4z' })).toEqual({
      version: PLUGIN_PANEL_PATH_ICON_SINCE,
      field: 'icon'
    })
    expect(floor('link')).toEqual({ version: PLUGIN_PANEL_UI_SINCE, field: 'icon' })
    expect(floor('database')).toEqual({ version: PLUGIN_SCHEMA_SINCE_V1, field: 'icon' })
  })

  it('leaves an undrawable path icon to the raw-manifest floor check', () => {
    // Why: the icon is dropped before this walk; pluginPanelIconEngineFloorError covers it.
    expect(floor({ path: 'M1. 2' })?.version).not.toBe(PLUGIN_PANEL_PATH_ICON_SINCE)
  })
})
