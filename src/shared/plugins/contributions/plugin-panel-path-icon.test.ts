import { expect, it } from 'vitest'
import {
  PLUGIN_PANEL_PATH_ICON_MAX_LENGTH,
  pluginPanelPathIconIssue,
  pluginPanelPathIconSchema
} from './plugin-panel-path-icon'

const CAP_MESSAGE = `must be at most ${PLUGIN_PANEL_PATH_ICON_MAX_LENGTH} characters`

it('stops at the length cap without scanning the rest of the path', () => {
  // Why both: past the cap, neither the character pattern nor the grammar check may run, so
  // the cap is the only issue even though each path also breaks one of those.
  for (const path of [
    `M${'x'.repeat(1_000_000)}`,
    `M${' 1'.repeat(PLUGIN_PANEL_PATH_ICON_MAX_LENGTH + 1)}`
  ]) {
    const parsed = pluginPanelPathIconSchema.safeParse({ path })
    expect(parsed.success).toBe(false)
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([CAP_MESSAGE])
    expect(pluginPanelPathIconIssue({ path })).toBe(`icon.path ${CAP_MESSAGE}`)
  }
})

it('still checks the pattern and grammar of a path within the cap', () => {
  const atCap = `M0 0${'h1'.repeat((PLUGIN_PANEL_PATH_ICON_MAX_LENGTH - 4) / 2)}`
  expect(atCap).toHaveLength(PLUGIN_PANEL_PATH_ICON_MAX_LENGTH)
  expect(pluginPanelPathIconIssue({ path: atCap })).toBeNull()
  expect(pluginPanelPathIconIssue({ path: 'M0 0x' })).toMatch(/must be SVG path data/)
  expect(pluginPanelPathIconIssue({ path: 'M0 0L1' })).toMatch(/needs 2 numbers per segment/)
})
