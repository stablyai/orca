import { Plug } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import type { ActivePluginPanel } from '@/store/plugin-panels'
import { getPluginPanelActivityItems, resolvePluginPanelIcon } from './plugin-panel-activity-items'

const panel: ActivePluginPanel = {
  id: 'dashboard',
  title: 'Dashboard',
  tabKey: 'plugin:samples.demo/dashboard',
  pluginKey: 'samples.demo',
  pluginName: 'Demo'
}

describe('resolvePluginPanelIcon', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'falls back to Plug for the prototype member %s',
    (iconName) => {
      expect(resolvePluginPanelIcon(iconName)).toBe(Plug)
    }
  )

  it('keeps a hostile manifest icon renderable by the activity bar', () => {
    // Inherited Object members are invalid React components and can crash the whole sidebar rail.
    const item = getPluginPanelActivityItems([{ ...panel, icon: 'constructor' }])[0]!
    expect(item.icon).not.toBe(Object)
    expect(item.icon).toBe(Plug)
  })
})
