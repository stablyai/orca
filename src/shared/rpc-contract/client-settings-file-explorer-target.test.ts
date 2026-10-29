import { describe, expect, it } from 'vitest'
import { SettingsUpdate } from './client-settings-params'

describe('file explorer target settings contract', () => {
  it.each(['current-workspace', 'floating-workspace'])(
    'accepts a supported target %s',
    (fileExplorerOpenTarget) => {
      expect(SettingsUpdate.parse({ fileExplorerOpenTarget })).toEqual({ fileExplorerOpenTarget })
    }
  )

  it.each(['new-window', true, null, {}])(
    'rejects an unsupported target %s',
    (fileExplorerOpenTarget) => {
      expect(SettingsUpdate.safeParse({ fileExplorerOpenTarget }).success).toBe(false)
    }
  )
})
