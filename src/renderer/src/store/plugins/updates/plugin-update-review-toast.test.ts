import { beforeEach, describe, expect, it } from 'vitest'
import type { PluginUpdateReviewNotice } from '../../../../../shared/plugins/catalog/plugin-update-policy'
import {
  announcePluginUpdateReviews,
  resolvePluginUpdateReviews,
  usePluginUpdateReviewNoticesStore
} from './plugin-update-review-toast'

const notice = (id: string, version: string): PluginUpdateReviewNotice => ({
  pluginKey: `acme.${id}`,
  name: id,
  publisher: 'acme',
  version,
  reason: 'access'
})
const shown = (): string[] =>
  usePluginUpdateReviewNoticesStore
    .getState()
    .notices.map((item) => `${item.pluginKey}@${item.version}`)

describe('held update notices', () => {
  beforeEach(() => usePluginUpdateReviewNoticesStore.setState({ notices: [] }))

  it('joins a later batch to the open one, a newer version replacing the older', () => {
    announcePluginUpdateReviews([notice('dusk', '2.0.0'), notice('dawn', '1.1.0')])
    announcePluginUpdateReviews([notice('dusk', '3.0.0')])
    expect(shown()).toEqual(['acme.dawn@1.1.0', 'acme.dusk@3.0.0'])
  })

  it('drops only what was handled, keeping a notice that arrived meanwhile', () => {
    const handled = [notice('dusk', '2.0.0'), notice('dawn', '1.1.0')]
    announcePluginUpdateReviews(handled)
    announcePluginUpdateReviews([notice('dusk', '3.0.0'), notice('noon', '0.2.0')])
    resolvePluginUpdateReviews(handled)
    expect(shown()).toEqual(['acme.dusk@3.0.0', 'acme.noon@0.2.0'])
  })
})
