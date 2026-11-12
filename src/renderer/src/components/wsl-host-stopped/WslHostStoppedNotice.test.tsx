// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/runtime/hosts/wsl/wsl-host-user-start', () => ({
  startWslHostAndReloadProjects: vi.fn(async () => true)
}))

import { WslHostStoppedNotice } from './WslHostStoppedNotice'

describe('WslHostStoppedNotice', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(() => act(() => root.unmount()))

  it('offers Start while the host is stopped', () => {
    act(() => root.render(<WslHostStoppedNotice environmentId="env" distro="demo" />))
    expect(container.textContent).toContain('demo is stopped')
    expect(container.querySelector('button')?.textContent).toBe('Start')
  })

  it('shows Connecting with no Start while the host boots', () => {
    act(() => root.render(<WslHostStoppedNotice environmentId="env" distro="demo" connecting />))
    expect(container.textContent).toContain('Connecting to demo…')
    expect(container.querySelector('[data-wsl-host-connecting]')).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
  })
})
