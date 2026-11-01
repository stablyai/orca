// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StoppedWslHost } from '../wsl-host-stopped/use-stopped-wsl-host'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'

const mocks = vi.hoisted(() => {
  const stopped: { current: StoppedWslHost | null } = { current: null }
  return {
    stopped,
    start: vi.fn<(environmentId: string) => Promise<boolean>>()
  }
})

vi.mock('../wsl-host-stopped/use-stopped-wsl-host', () => ({
  useStoppedWslHost: (worktreeId: string | undefined) =>
    worktreeId === 'wt-wsl' ? mocks.stopped.current : null
}))
vi.mock('@/lib/wsl-host-user-start', () => ({
  startWslHostAndReloadProjects: mocks.start
}))

afterEach(() => {
  cleanup()
  mocks.stopped.current = null
  mocks.start.mockReset()
})

describe('EditorFileLoadErrorView on a stopped WSL host', () => {
  it('offers Start instead of the read error, and reloads the file once started', async () => {
    mocks.stopped.current = { environmentId: 'wsl:ubuntu', distro: 'Ubuntu' }
    mocks.start.mockResolvedValue(true)
    const onRetry = vi.fn()
    const view = render(
      <EditorFileLoadErrorView
        message="The server isn't answering"
        worktreeId="wt-wsl"
        onRetry={onRetry}
      />
    )
    expect(view.queryByText('Unable to load file')).toBeNull()
    expect(view.getByText('Ubuntu is stopped')).toBeTruthy()
    expect(mocks.start).not.toHaveBeenCalled()

    await act(async () => fireEvent.click(view.getByRole('button', { name: 'Start' })))
    expect(mocks.start).toHaveBeenCalledWith('wsl:ubuntu')
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('keeps the read error and Retry for any other workspace', () => {
    mocks.stopped.current = { environmentId: 'wsl:ubuntu', distro: 'Ubuntu' }
    const view = render(
      <EditorFileLoadErrorView
        message="Permission denied"
        worktreeId="wt-local"
        onRetry={vi.fn()}
      />
    )
    expect(view.getByText('Unable to load file')).toBeTruthy()
    expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(view.queryByText('Ubuntu is stopped')).toBeNull()
  })
})
