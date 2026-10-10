import { describe, expect, it } from 'vitest'
import { parsePluginManifest } from './plugin-manifest'
import {
  PLUGIN_STATUS_BAR_ITEM_LIMIT,
  PLUGIN_STATUS_BAR_TEXT_MAX_LENGTH,
  pluginStatusBarUpdateParamsSchema
} from './plugin-status-bar'

function manifest(overrides: {
  main?: string | null
  statusBarItems?: unknown[]
  capabilities?: { kind: string }[]
}): unknown {
  return {
    manifestVersion: 1,
    id: 'live-status',
    publisher: 'orca-samples',
    name: 'Live Status',
    version: '1.0.0',
    engines: { orca: '>=1.0.0' },
    pluginApi: 1,
    ...(overrides.main === null ? {} : { main: overrides.main ?? 'main.mjs' }),
    contributes: {
      panels: [{ id: 'live', title: 'Live', entry: 'panel.html' }],
      // Worker commands would require `main` too and mask the error under test.
      commands: overrides.main === null ? [] : [{ id: 'live-status-reset', title: 'Reset' }],
      statusBarItems: overrides.statusBarItems ?? [{ id: 'pulse' }]
    },
    capabilities: overrides.capabilities ?? [{ kind: 'statusBar' }]
  }
}

describe('contributes.statusBarItems', () => {
  it('accepts items that reference their own command or panel', () => {
    const parsed = parsePluginManifest(
      manifest({
        statusBarItems: [
          { id: 'pulse', alignment: 'left', priority: 5, command: 'live-status-reset' },
          { id: 'open', panel: 'live' }
        ]
      })
    )
    expect(parsed.ok).toBe(true)
    expect(parsed.ok && parsed.manifest.contributes.statusBarItems).toEqual([
      { id: 'pulse', alignment: 'left', priority: 5, command: 'live-status-reset' },
      { id: 'open', panel: 'live' }
    ])
  })

  it.each([
    [
      { statusBarItems: [{ id: 'pulse', command: 'other-command' }] },
      'unknown contributed command'
    ],
    [{ statusBarItems: [{ id: 'pulse', panel: 'other' }] }, 'unknown contributed panel'],
    [
      { statusBarItems: [{ id: 'pulse', command: 'live-status-reset', panel: 'live' }] },
      'either command or panel'
    ],
    [{ statusBarItems: [{ id: 'pulse' }, { id: 'pulse' }] }, 'duplicate statusBarItems id'],
    [{ statusBarItems: [{ id: 'Pulse' }] }, 'kebab-case'],
    [{ statusBarItems: [{ id: 'pulse', html: '<b>x</b>' }] }, 'Unrecognized key'],
    [{ statusBarItems: [{ id: 'pulse', priority: 1.5 }] }, 'expected int'],
    [{ capabilities: [] }, 'statusBar capability required'],
    [{ main: null }, 'required when contributes.statusBarItems is non-empty'],
    [
      { main: null, statusBarItems: [], capabilities: [{ kind: 'panelMessaging' }] },
      'panelMessaging'
    ]
  ])('rejects %j', (overrides, error) => {
    const parsed = parsePluginManifest(manifest(overrides))
    expect(parsed.ok).toBe(false)
    expect(parsed.ok ? '' : parsed.error).toContain(error)
  })

  it('caps the number of items per plugin', () => {
    const items = Array.from({ length: PLUGIN_STATUS_BAR_ITEM_LIMIT + 1 }, (_, index) => ({
      id: `item-${index}`
    }))
    expect(parsePluginManifest(manifest({ statusBarItems: items })).ok).toBe(false)
  })
})

describe('statusBar.update params', () => {
  it('caps text length and keeps plain text on one safe line', () => {
    expect(
      pluginStatusBarUpdateParamsSchema.safeParse({
        itemId: 'pulse',
        text: 'x'.repeat(PLUGIN_STATUS_BAR_TEXT_MAX_LENGTH + 1)
      }).success
    ).toBe(false)
    const parsed = pluginStatusBarUpdateParamsSchema.parse({
      itemId: 'pulse',
      text: 'CPU\n\u202e42%\u0007',
      tooltip: 'line one\r\nline two'
    })
    expect(parsed.text).toBe('CPU  42% ')
    expect(parsed.tooltip).toBe('line one  line two')
  })

  it('accepts only the documented severities and fields', () => {
    expect(
      pluginStatusBarUpdateParamsSchema.safeParse({
        itemId: 'pulse',
        text: 'x',
        severity: 'warning'
      }).success
    ).toBe(true)
    expect(
      pluginStatusBarUpdateParamsSchema.safeParse({ itemId: 'pulse', text: 'x', severity: 'info' })
        .success
    ).toBe(false)
    expect(
      pluginStatusBarUpdateParamsSchema.safeParse({ itemId: 'pulse', text: 'x', color: 'red' })
        .success
    ).toBe(false)
  })
})
