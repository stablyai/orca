// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NeedsSetupProjectHostOption } from '@/lib/workspace/creation/project-host-setup-options'

const storeMocks = vi.hoisted(() => ({
  setupProjectExistingFolder: vi.fn(),
  setupProjectClone: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(storeMocks)
}))

vi.mock('@/components/sidebar/host-path-browser/RemoteFileBrowser', () => ({
  RemoteFileBrowser: ({
    targetId,
    onSelect,
    onCancel
  }: {
    targetId?: string
    onSelect: (path: string) => void
    onCancel: () => void
  }) => (
    <div data-testid="remote-file-browser" data-target={targetId ?? ''}>
      <button type="button" onClick={() => onSelect('/remote/orca')}>
        Select remote folder
      </button>
      <button type="button" onClick={onCancel}>
        Cancel browse
      </button>
    </div>
  )
}))

import { SetProjectLocationDialog } from './SetProjectLocationDialog'

const option: NeedsSetupProjectHostOption = {
  kind: 'needs-setup',
  id: 'needs-setup:ssh:openclaw',
  projectId: 'project-orca',
  hostId: 'ssh:openclaw',
  label: 'openclaw',
  detail: 'Project location not set',
  isAvailable: true,
  attention: false,
  canSetLocation: true
}

function renderDialog(
  overrides: Partial<ComponentProps<typeof SetProjectLocationDialog>> = {}
): ReturnType<typeof userEvent.setup> {
  const user = userEvent.setup()
  render(
    <SetProjectLocationDialog
      option={option}
      projectName="orca"
      projectKind="git"
      defaultCloneUrl="git@github.com:stablyai/orca.git"
      onClose={vi.fn()}
      onReady={vi.fn()}
      {...overrides}
    />
  )
  return user
}

afterEach(() => {
  cleanup()
})

describe('SetProjectLocationDialog', () => {
  it('backs out of the host browser on Escape instead of discarding the form', async () => {
    const onClose = vi.fn()
    const user = renderDialog({ onClose })

    await user.click(screen.getByRole('button', { name: /Browse folder/ }))
    await user.click(screen.getByRole('button', { name: 'Browse host filesystem' }))
    expect(screen.getByTestId('remote-file-browser')).toBeTruthy()

    await user.keyboard('{Escape}')

    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByTestId('remote-file-browser')).toBeNull()
    expect(screen.getByRole('button', { name: 'Set location' })).toBeTruthy()

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()
  })
})

it('updates an untouched late clone seed, preserves typed URL across late/reordered/removed catalog answers, and allows manual URL without source', async () => {
  const onReady = vi.fn()
  const props = {
    option,
    projectName: 'App',
    projectKind: 'git' as const,
    defaultCloneUrl: '',
    onClose: vi.fn(),
    onReady
  }
  const view = render(<SetProjectLocationDialog {...props} />)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Clone from URL/ }))
  const url = screen.getByPlaceholderText('Repository URL')
  if (!(url instanceof HTMLInputElement)) {
    throw new Error('Repository URL input missing')
  }
  view.rerender(
    <SetProjectLocationDialog {...props} defaultCloneUrl="https://github.com/late/app.git" />
  )
  expect(url.value).toBe('https://github.com/late/app.git')
  await user.clear(url)
  await user.type(url, 'https://github.com/typed/app.git')
  view.rerender(
    <SetProjectLocationDialog {...props} defaultCloneUrl="https://github.com/reordered/app.git" />
  )
  expect(url.value).toBe('https://github.com/typed/app.git')
  view.rerender(<SetProjectLocationDialog {...props} defaultCloneUrl="" />)
  await user.type(screen.getByPlaceholderText('/destination/on/host'), '/manual/app')
  await user.click(screen.getByRole('button', { name: 'Clone' }))
  expect(storeMocks.setupProjectClone).toHaveBeenCalledWith(
    expect.objectContaining({
      url: 'https://github.com/typed/app.git',
      destination: '/manual/app',
      hostId: option.hostId
    })
  )
})
