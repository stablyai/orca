import { expect, it } from 'vitest'
import { restoresSavedContentTab } from './editor-tabs/saved-editor-tab-restore'

it('drops a pipeline view after restart when its document is absent and retains it during a live reconnect', () => {
  const tab = { contentType: 'editor' as const, entityId: 'pipeline-run:instance-1:run-1' }
  expect(restoresSavedContentTab(tab, new Set(), () => false)).toBe(false)
  expect(restoresSavedContentTab(tab, new Set(), () => true)).toBe(true)
  expect(
    restoresSavedContentTab(
      { contentType: 'editor', entityId: '/project/README.md' },
      new Set(['/project/README.md']),
      () => false
    )
  ).toBe(true)
})
