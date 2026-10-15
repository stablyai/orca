import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ updateWorktreeMeta: vi.fn(), toastError: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ updateWorktreeMeta: mocks.updateWorktreeMeta }) }
}))

import type { LinkedPluginTask } from '../../../shared/plugins/plugin-task-link'
import { persistCreatedWorkspacePluginTaskLink } from './plugin-task-workspace-link'

const link: LinkedPluginTask = {
  pluginKey: 'orca-samples.hello-tasks',
  sourceId: 'samples',
  itemId: 'a',
  title: 'A',
  sourceTitle: 'Hello Tasks'
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  mocks.updateWorktreeMeta.mockReset()
  mocks.toastError.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('persistCreatedWorkspacePluginTaskLink', () => {
  it('writes the link without reporting anything when the save succeeds', async () => {
    mocks.updateWorktreeMeta.mockResolvedValue({ ok: true })
    persistCreatedWorkspacePluginTaskLink('wt-1', link)
    await settle()
    expect(mocks.updateWorktreeMeta).toHaveBeenCalledWith('wt-1', { linkedPluginTask: link })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('reports a rejected or failed save instead of dropping the link silently', async () => {
    mocks.updateWorktreeMeta.mockResolvedValueOnce({ ok: false, error: 'disk full' })
    persistCreatedWorkspacePluginTaskLink('wt-1', link)
    await settle()
    mocks.updateWorktreeMeta.mockRejectedValueOnce(new Error('ipc closed'))
    persistCreatedWorkspacePluginTaskLink('wt-2', link)
    await settle()
    expect(mocks.toastError).toHaveBeenCalledTimes(2)
  })

  it('does nothing for a workspace that did not come from a plugin task', async () => {
    persistCreatedWorkspacePluginTaskLink('wt-1', undefined)
    await settle()
    expect(mocks.updateWorktreeMeta).not.toHaveBeenCalled()
  })
})
