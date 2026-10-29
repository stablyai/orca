// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import type { TaskSourceContext } from '../../../../shared/task-source-context'

const clickUpStatus = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-clickup-client', () => ({
  clickUpStatus
}))

import { useClickUpSourceConnection } from './use-clickup-source-connection'

const sourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'clickup',
  projectId: 'repo-a',
  hostId: 'runtime:env-a'
}

describe('useClickUpSourceConnection', () => {
  it('reads ClickUp status from the selected source host', async () => {
    clickUpStatus.mockResolvedValueOnce({ connected: true, viewer: { id: 1, username: 'me' } })

    const { result } = renderHook(() =>
      useClickUpSourceConnection({ enabled: true, sourceContext })
    )

    await waitFor(() => {
      expect(result.current.loaded).toBe(true)
    })
    expect(clickUpStatus).toHaveBeenCalledWith(sourceContext)
    expect(result.current.status?.connected).toBe(true)
  })
})
