// @vitest-environment happy-dom
import {
  context,
  mount,
  direct,
  container,
  update,
  click,
  draft
} from './github-task-refresh.test-fixture'
import { seed, oldDetails, returned, user } from './github-task-refresh-data.test-fixture'
import { act } from 'react'
import { it, expect } from 'vitest'
import type { GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import {
  workItemDetailsCache,
  invalidateWorkItemDetailsCacheForKey
} from '@/components/github-item-dialog/load-item-details/work-item-details-cache'

it.each(['rollback', 'confirmed'])(
  'derives ordinary membership while retaining pending edits and %s, then accepts nonempty and Full[] without losing drafts',
  async (outcome) => {
    await mount(true)
    const ordinaryKey = [...workItemDetailsCache.keys()][0]
    direct.mockResolvedValueOnce({ ...oldDetails, item: { ...seed, assignees: [user('cora')] } })
    await act(async () => invalidateWorkItemDetailsCacheForKey(ordinaryKey))
    expect(container.querySelector('[data-assignees]')?.textContent).toBe('cora')
    const ordinary = Promise.withResolvers<GitHubWorkItemDetails | null>()
    direct.mockReturnValueOnce(ordinary.promise)
    const writing = Promise.withResolvers<{ ok: boolean; error?: string }>()
    update.mockReturnValueOnce(writing.promise)
    await click('Add Bob')
    await act(async () => invalidateWorkItemDetailsCacheForKey(ordinaryKey))
    await act(async () =>
      ordinary.resolve({ ...oldDetails, item: { ...seed, assignees: [user('dora')] } })
    )
    expect(container.querySelector('[data-assignees]')?.textContent).toBe('cora,bob')
    await act(async () =>
      writing.resolve(outcome === 'rollback' ? { ok: false, error: 'Rejected' } : { ok: true })
    )
    expect(container.querySelector('[data-assignees]')?.textContent).toBe(
      outcome === 'rollback' ? 'cora' : 'cora,bob'
    )
    await draft('Body draft', 'Keep body')
    await draft('Comment draft', 'Keep comment')
    direct.mockResolvedValueOnce({
      ...returned,
      item: { ...returned.item, assignees: [user('dora')] }
    })
    await click()
    expect(container.querySelector('[data-assignees]')?.textContent).toBe('dora')
    direct.mockResolvedValueOnce({ ...returned, item: { ...returned.item, assignees: [] } })
    await click()
    expect(container.querySelector('[data-assignees]')?.textContent).toBe('')
    await click('Add Bob')
    expect(container.querySelector('[data-assignees]')?.textContent).toBe('bob')
    expect(container.querySelector<HTMLInputElement>('[aria-label="Body draft"]')?.value).toBe(
      'Keep body'
    )
    expect(container.querySelector<HTMLInputElement>('[aria-label="Comment draft"]')?.value).toBe(
      'Keep comment'
    )
    context.openedItem = {
      ...seed,
      id: 'issue:6',
      number: 6,
      url: 'https://github.com/o/r/issues/6'
    }
    direct.mockResolvedValueOnce({
      ...oldDetails,
      item: { ...context.openedItem, assignees: [user('other')] }
    })
    await mount(true)
    expect(container.querySelector('[data-assignees]')?.textContent).toBe('other')
  }
)
