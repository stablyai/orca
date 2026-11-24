import { describe, expect, it, vi } from 'vitest'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { createGlobalSettingsFixture } from '../../../../../shared/settings/global-settings-test-fixture'
import { applyTerminalAppearance } from './terminal-appearance'

vi.mock('./terminal-view-attributes-publisher', () => ({
  publishTerminalViewAttributes: vi.fn()
}))

function applyTo(
  options: Record<string, unknown>,
  terminalBoldBrightColors: boolean | undefined
): void {
  const pane = {
    id: 1,
    leafId: 'leaf-1',
    terminal: { options, cols: 80, rows: 24 }
  }
  const manager = {
    getPanes: () => [pane],
    setPaneLigaturesEnabled: vi.fn(),
    setPaneInlineImagesEnabled: vi.fn(),
    setPaneStyleOptions: vi.fn()
  } as unknown as PaneManager
  applyTerminalAppearance(
    manager,
    createGlobalSettingsFixture({ terminalBoldBrightColors }),
    true,
    new Map(),
    'false',
    new Map(),
    new Map()
  )
}

describe('applyTerminalAppearance bold text in bright colors', () => {
  it('updates an open pane when the setting is toggled', () => {
    const options: Record<string, unknown> = { drawBoldTextInBrightColors: true }
    applyTo(options, false)
    expect(options.drawBoldTextInBrightColors).toBe(false)
    applyTo(options, true)
    expect(options.drawBoldTextInBrightColors).toBe(true)
    applyTo(options, undefined)
    expect(options.drawBoldTextInBrightColors).toBe(true)
  })
})
