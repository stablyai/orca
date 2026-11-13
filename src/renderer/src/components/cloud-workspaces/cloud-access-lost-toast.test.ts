import { beforeEach, describe, expect, it, vi } from 'vitest'

type ToastAction = { label: string; onClick: () => void }
const toasts = vi.hoisted(() => {
  const list: { title: string; action: ToastAction }[] = []
  return list
})
vi.mock('sonner', () => ({
  toast: {
    warning: (title: string, options: { action: ToastAction }) => {
      toasts.push({ title, action: options.action })
    }
  }
}))

import {
  resetCloudAccessLostToastsForTests,
  showCloudAccessLostToast
} from './cloud-access-lost-toast'

beforeEach(() => {
  toasts.length = 0
  resetCloudAccessLostToastsForTests()
})

describe('cloud access lost (EP-8)', () => {
  it('says so once per server, with one fix: remove it from this computer', () => {
    const remove = vi.fn(async () => undefined)
    const lost = { environmentId: 'env-1', sandboxId: 'sbx_1' }
    showCloudAccessLostToast(lost, remove)
    showCloudAccessLostToast(lost, remove)
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.title).toBe('You can’t open this cloud workspace anymore')
    expect(toasts[0]?.action.label).toBe('Remove from this computer')
    toasts[0]?.action.onClick()
    expect(remove).toHaveBeenCalledWith('env-1')
  })
})
