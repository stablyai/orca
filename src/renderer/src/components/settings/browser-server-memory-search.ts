import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'

// Server browser memory entries live here so browser-search.ts stays under max-lines.
export function getBrowserServerMemorySearchEntries(): SettingsSearchEntry[] {
  return [
    {
      title: translate(
        'settings.browser.serverMemory.search.paintTitle',
        'Server Browser Memory: Server tab rendering'
      ),
      description: translate(
        'settings.browser.serverMemory.search.paintDescription',
        'Applies to `orca serve`. Controls whether headless server browser tabs paint immediately or stay invisible until first shown.'
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.server',
          'server'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.memory',
          'memory'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.render',
          'render'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.paint',
          'paint'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.gpu',
          'gpu'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.serve',
          'serve'
        )
      ]
    },
    {
      title: translate(
        'settings.browser.serverMemory.search.idleSleepTitle',
        'Server Browser Memory: Sleep idle server browser tabs'
      ),
      description: translate(
        'settings.browser.serverMemory.search.idleSleepDescription',
        'Applies to `orca serve`. Puts headless server browser tabs to sleep after a period without activity to free memory.'
      ),
      keywords: [
        ...translateSearchKeyword('auto.components.settings.browser.search.2d2d995c58', 'browser'),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.server',
          'server'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.memory',
          'memory'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.sleep',
          'sleep'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.idle',
          'idle'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.browser.search.serverMemory.serve',
          'serve'
        )
      ]
    }
  ]
}
