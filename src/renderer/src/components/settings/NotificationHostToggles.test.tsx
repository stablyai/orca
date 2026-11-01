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

  it('allows expansion while the master switch disables machine changes', () => {
    hostOptions.current = [host('local', 'Local Mac'), host('runtime:m4air', 'M4Air mac')]
    const onChange = vi.fn()
    const onPhoneChange = vi.fn()
    const { getByRole, getAllByRole } = render(
      <NotificationHostToggles
        mutedNotificationSourceIds={['local']}
        phoneMutedNotificationSourceIds={[]}
        disabled
        onChange={onChange}
        onPhoneChange={onPhoneChange}
      />
    )
    const heading = getByRole('button', { name: /Machines/ })
    expect(heading.hasAttribute('disabled')).toBe(false)
    fireEvent.click(heading)
    const switches = getAllByRole('switch')
    expect(switches).toHaveLength(3)
    for (const toggle of switches) {
      expect(toggle.hasAttribute('disabled')).toBe(true)
      fireEvent.click(toggle)
    }
    expect(onChange).not.toHaveBeenCalled()
    expect(onPhoneChange).not.toHaveBeenCalled()
  })

  it('offers a phone switch per remote machine that stays independent of the banner switch', () => {
    hostOptions.current = [host('local', 'Local Mac'), host('runtime:m4air', 'M4Air mac')]
    const onChange = vi.fn()
    const onPhoneChange = vi.fn()
    const { getByRole, getAllByRole } = render(
      <NotificationHostToggles
        mutedNotificationSourceIds={[]}
        phoneMutedNotificationSourceIds={['runtime:m4air']}
        disabled={false}
        onChange={onChange}
        onPhoneChange={onPhoneChange}
      />
    )
    fireEvent.click(getByRole('button', { name: /Machines/ }))
    expect(getAllByRole('switch', { name: /^Push .* to phone$/ })).toHaveLength(1)
    const phoneSwitch = getByRole('switch', { name: 'Push M4Air mac to phone' })
    expect(phoneSwitch.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(phoneSwitch)
    expect(onPhoneChange).toHaveBeenCalledWith(['runtime:m4air'], false)
    expect(onChange).not.toHaveBeenCalled()
    expect(getByRole('switch', { name: 'M4Air mac' }).getAttribute('aria-checked')).toBe('true')
  })
})
