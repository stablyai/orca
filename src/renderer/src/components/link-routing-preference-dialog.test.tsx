// @vitest-environment happy-dom
import { cleanup, render, renderHook, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LinkRoutingPreferenceDialogProvider } from './link-routing-preference-dialog'
import {
  useLinkRoutingPreferenceDialog,
  type LinkRoutingPreferenceDialogOptions
} from './link-routing-preference-dialog-context'

const mocks = vi.hoisted(() => ({ setBlocking: vi.fn() }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ setContextualToursBlockingSurfaceVisible: mocks.setBlocking })
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  mocks.setBlocking.mockClear()
})

function Harness({
  options,
  onSettled
}: {
  options?: LinkRoutingPreferenceDialogOptions
  onSettled: (openInOrca: boolean) => void
}): React.JSX.Element {
  const requestPreference = useLinkRoutingPreferenceDialog()
  return <button onClick={() => void requestPreference(options).then(onSettled)}>Ask</button>
}

describe('LinkRoutingPreferenceDialogProvider', () => {
  it('provides the shared context and resolves the Orca choice', async () => {
    const onSettled = vi.fn()
    render(
      <LinkRoutingPreferenceDialogProvider>
        <Harness options={{ url: 'https://example.test/path' }} onSettled={onSettled} />
      </LinkRoutingPreferenceDialogProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByText('example.test')).toBeTruthy()
    expect(mocks.setBlocking).toHaveBeenLastCalledWith(true)
    await userEvent.click(screen.getByRole('button', { name: 'Open in Orca' }))
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(true))
    expect(mocks.setBlocking).toHaveBeenLastCalledWith(false)
  })

  it('retains the existing Orca default and allows choosing the system browser', async () => {
    const onSettled = vi.fn()
    render(
      <LinkRoutingPreferenceDialogProvider>
        <Harness options={{ openLinksInAppDefault: true }} onSettled={onSettled} />
      </LinkRoutingPreferenceDialogProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    expect(screen.getByRole('button', { name: 'Keep Orca' })).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: 'Use system browser' }))
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(false))
  })

  it('cancels with Escape instead of opening a link', async () => {
    const onSettled = vi.fn()
    render(
      <LinkRoutingPreferenceDialogProvider>
        <Harness onSettled={onSettled} />
      </LinkRoutingPreferenceDialogProvider>
    )
    await userEvent.click(screen.getByRole('button', { name: 'Ask' }))
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(false))
    expect(onSettled).toHaveBeenCalledTimes(1)
  })

  it('still reports genuinely missing providers', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => renderHook(() => useLinkRoutingPreferenceDialog())).toThrow(
      'useLinkRoutingPreferenceDialog must be used inside LinkRoutingPreferenceDialogProvider'
    )
  })
})
