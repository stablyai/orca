// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SidebarHostOption } from '../sidebar/sidebar-host-options'
import { NotificationHostToggles } from './NotificationHostToggles'

const { hostOptions } = vi.hoisted(() => {
  const current: SidebarHostOption[] = []
  return { hostOptions: { current } }
})

vi.mock('./use-notification-source-options', () => ({
  useNotificationSourceOptions: () => hostOptions.current
}))

afterEach(cleanup)

function host(id: SidebarHostOption['id'], label: string): SidebarHostOption {
  return {
    id,
    label,
    detail: id === 'local' ? 'This computer' : 'Orca server',
    kind: id === 'local' ? 'local' : 'runtime',
    health: 'local',
    presence: 'local'
  }
}

describe('NotificationHostToggles', () => {
  it('stays hidden when this computer is the only machine and only stale ids are muted', () => {
    hostOptions.current = [host('local', 'Local Mac')]
    const { container, rerender } = render(
      <NotificationHostToggles
        mutedNotificationSourceIds={[]}
        disabled={false}
        onChange={vi.fn()}
      />
    )
    expect(container.innerHTML).toBe('')
    rerender(
      <NotificationHostToggles
        mutedNotificationSourceIds={['ssh:removed']}
        disabled={false}
        onChange={vi.fn()}
      />
    )
    expect(container.innerHTML).toBe('')
  })

  it('starts collapsed with no switches or off count and expands from its heading', () => {
    hostOptions.current = [host('local', 'Local Mac'), host('runtime:m4air', 'M4Air mac')]
    const { getByRole, queryAllByRole, queryByText } = render(
      <NotificationHostToggles
        mutedNotificationSourceIds={[]}
        disabled={false}
        onChange={vi.fn()}
      />
    )
    const heading = getByRole('button', { name: /Machines/ })
    expect(heading.getAttribute('aria-expanded')).toBe('false')
    expect(queryAllByRole('switch')).toHaveLength(0)
    expect(queryByText(/\d+ off/)).toBeNull()
    fireEvent.click(heading)
    expect(heading.getAttribute('aria-expanded')).toBe('true')
    expect(queryAllByRole('switch')).toHaveLength(2)
    expect(getByRole('switch', { name: 'Local Mac' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(heading)
    expect(queryAllByRole('switch')).toHaveLength(0)
  })

  it('counts only listed muted machines and preserves their toggle behavior', () => {
    hostOptions.current = [host('local', 'Local Mac'), host('runtime:m4air', 'M4Air mac')]
    const onChange = vi.fn()
    const { getByRole, getByText, queryByText, rerender } = render(
      <NotificationHostToggles
        mutedNotificationSourceIds={['runtime:m4air', 'ssh:removed']}
        disabled={false}
        onChange={onChange}
      />
    )
    expect(getByText('1 off')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: /Machines/ }))
    const remoteSwitch = getByRole('switch', { name: 'M4Air mac' })
    expect(remoteSwitch.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(remoteSwitch)
    expect(onChange).toHaveBeenCalledWith(['runtime:m4air'], false)
    fireEvent.click(getByRole('switch', { name: 'Local Mac' }))
    expect(onChange).toHaveBeenCalledWith(['local'], true)
    fireEvent.click(getByRole('button', { name: /Machines/ }))
    rerender(
      <NotificationHostToggles
        mutedNotificationSourceIds={['local', 'runtime:m4air']}
        disabled={false}
        onChange={onChange}
      />
    )
    expect(getByText('2 off')).toBeTruthy()
    rerender(
      <NotificationHostToggles
        mutedNotificationSourceIds={[]}
        disabled={false}
        onChange={onChange}
      />
    )
    expect(queryByText(/\d+ off/)).toBeNull()
  })

  it('keeps the last listed muted machine reachable without reviving removed machines', () => {
    hostOptions.current = [host('local', 'Local Mac')]
    const { getByRole, getByText, queryAllByRole, queryByText } = render(
      <NotificationHostToggles
        mutedNotificationSourceIds={['local', 'ssh:removed']}
        disabled={false}
        onChange={vi.fn()}
      />
    )
    expect(getByText('1 off')).toBeTruthy()
    expect(queryAllByRole('switch')).toHaveLength(0)
    fireEvent.click(getByRole('button', { name: /Machines/ }))
    expect(getByRole('switch', { name: 'Local Mac' }).getAttribute('aria-checked')).toBe('false')
    expect(queryAllByRole('switch')).toHaveLength(1)
    expect(queryByText(/removed/)).toBeNull()
  })

  it('allows expansion while the master switch disables machine changes', () => {
    hostOptions.current = [host('local', 'Local Mac'), host('runtime:m4air', 'M4Air mac')]
    const onChange = vi.fn()
    const { getByRole, getAllByRole } = render(
      <NotificationHostToggles
        mutedNotificationSourceIds={['local']}
        disabled
        onChange={onChange}
      />
    )
    const heading = getByRole('button', { name: /Machines/ })
    expect(heading.hasAttribute('disabled')).toBe(false)
    fireEvent.click(heading)
    for (const toggle of getAllByRole('switch')) {
      expect(toggle.hasAttribute('disabled')).toBe(true)
      fireEvent.click(toggle)
    }
    expect(onChange).not.toHaveBeenCalled()
  })

  it('starts collapsed again after remounting the pane', () => {
    hostOptions.current = [host('local', 'Local Mac'), host('runtime:m4air', 'M4Air mac')]
    const props = { mutedNotificationSourceIds: [], disabled: false, onChange: vi.fn() }
    const first = render(<NotificationHostToggles {...props} />)
    fireEvent.click(first.getByRole('button', { name: /Machines/ }))
    expect(first.queryAllByRole('switch')).toHaveLength(2)
    first.unmount()
    const second = render(<NotificationHostToggles {...props} />)
    expect(second.getByRole('button', { name: /Machines/ }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(second.queryAllByRole('switch')).toHaveLength(0)
  })
})
