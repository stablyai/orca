import { Plug } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import { resolvePluginPanelIcon } from './plugin-panel-activity-items'

describe('resolvePluginPanelIcon', () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])(
    'falls back to Plug for the prototype member %s',
    (iconName) => {
      expect(resolvePluginPanelIcon(iconName)).toBe(Plug)
    }
  )
})
