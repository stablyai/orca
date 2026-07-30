import { FileText, Plug } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import type { ActivePluginPanel } from '@/store/plugin-panels'
import { getPluginPanelActivityItems, resolvePluginPanelIcon } from './plugin-panel-activity-items'

const panel: ActivePluginPanel = {
  id: 'dashboard',
  title: 'Dashboard',
  tabKey: 'plugin:orca-samples.demo/dashboard',
  pluginKey: 'orca-samples.demo',
  pluginName: 'Demo'
}

describe('resolvePluginPanelIcon', () => {
  it('resolves a curated icon name in both lucide naming styles', () => {
    const dashed = resolvePluginPanelIcon('file-text')
    // Without this, the equality below also passes when both sides fall back.
    expect(dashed).toBe(FileText)
    expect(resolvePluginPanelIcon('FileText')).toBe(dashed)
  })

  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'falls back to Plug for the prototype member %s',
    (iconName) => {
      expect(resolvePluginPanelIcon(iconName)).toBe(Plug)
    }
  )

  it('keeps a hostile manifest icon renderable by the activity bar', () => {
    // Object / Object.prototype are not valid React element types: rendering
    // either throws past the right-sidebar boundary and blanks the whole rail.
    const item = getPluginPanelActivityItems([{ ...panel, icon: 'constructor' }])[0]!
    expect(item.icon).not.toBe(Object)
    expect(item.icon).toBe(Plug)
  })
})

describe('getPluginPanelActivityItems', () => {
  it('projects watchdog failure into host-owned activity chrome', () => {
    expect(
      getPluginPanelActivityItems([panel], {
        'plugin:orca-samples.demo/dashboard': true
      })[0]
    ).toMatchObject({
      id: panel.tabKey,
      statusIndicator: 'failure'
    })
  })
})
