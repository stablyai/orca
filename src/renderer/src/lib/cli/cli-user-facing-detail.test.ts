import { expect, it, vi } from 'vitest'

// The key shows in the text, so the test sees which strings are localized.
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string, vars?: Record<string, string | number>) =>
    `[${key}] ${fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''))}`
}))

import { formatCliUserFacingDetail } from './cli-user-facing-detail'

it('localizes the status of a link that another Orca app owns', () => {
  expect(
    formatCliUserFacingDetail(
      '/usr/local/bin/orca belongs to another Orca app (/Applications/Orca.app). Register replaces it. To switch back, register the CLI again in that app.'
    )
  ).toBe(
    '[auto.lib.cli.detail.otherAppOwnsLink] /usr/local/bin/orca belongs to another Orca app (/Applications/Orca.app). Register replaces it. To switch back, register the CLI again in that app.'
  )
})

it('localizes the detail after Register replaced the link of another Orca app', () => {
  expect(
    formatCliUserFacingDetail(
      'Replaced the /usr/local/bin/orca link to /Applications/Orca.app. To switch back, register the CLI again in that app.'
    )
  ).toBe(
    '[auto.lib.cli.detail.replacedOtherAppLink] Replaced the /usr/local/bin/orca link to /Applications/Orca.app. To switch back, register the CLI again in that app.'
  )
})
