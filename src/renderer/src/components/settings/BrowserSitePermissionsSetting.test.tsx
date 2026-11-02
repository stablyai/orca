// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrowserSitePermissionEntry } from '../../../../shared/browser-site-permission'
import type { BrowserSessionProfile } from '../../../../shared/browser-workspace-types'

const storeState = vi.hoisted(() => {
  const profile = (id: string, label: string): BrowserSessionProfile => ({
    id,
    label,
    scope: id === 'default' ? 'default' : 'isolated',
    partition: `persist:${id}`,
    source: null
  })
  return {
    settingsSearchQuery: '',
    fetchBrowserSessionProfiles: async () => {},
    browserSessionProfilesByHostId: {
      local: [profile('default', 'Default'), profile('work', 'Work')]
    }
  }
})

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

// Why: Radix Select needs pointer/layout APIs happy-dom lacks; a native select keeps value testable.
vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

import { BrowserSitePermissionsSetting } from './BrowserSitePermissionsSetting'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const permissionSelects = (): HTMLElement[] =>
  screen.queryAllByRole('combobox').filter((select) => within(select).queryByText('Ask again'))

afterEach(cleanup)

it("never shows or edits one profile's sites under another", async () => {
  const workList = deferred<BrowserSitePermissionEntry[]>()
  const defaultWrite = deferred<BrowserSitePermissionEntry[]>()
  const sitePermissionsList = vi.fn(({ profileId }: { profileId: string }) =>
    profileId === 'work'
      ? workList.promise
      : Promise.resolve([{ origin: 'https://a.test', decisions: { location: 'block' } }])
  )
  const sitePermissionsSet = vi.fn(({ profileId }: { profileId: string }) =>
    profileId === 'default' ? defaultWrite.promise : Promise.resolve([])
  )
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { browser: { sitePermissionsList, sitePermissionsSet } }
  })
  render(<BrowserSitePermissionsSetting />)

  expect(await screen.findByText('a.test')).toBeInTheDocument()
  fireEvent.change(permissionSelects()[0], { target: { value: 'allow' } })
  expect(sitePermissionsSet).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId: 'default', permission: 'location', decision: 'allow' })
  )

  // Switch to Work while its sites are still loading, then let Default's reply land late.
  const profileSelect = screen
    .getAllByRole('combobox')
    .find((select) => within(select).queryByText('Work'))
  fireEvent.change(profileSelect!, { target: { value: 'work' } })
  expect(screen.queryByText('a.test')).not.toBeInTheDocument()
  expect(permissionSelects()).toEqual([])
  await act(async () => {
    defaultWrite.resolve([{ origin: 'https://a.test', decisions: { location: 'allow' } }])
  })
  expect(screen.queryByText('a.test')).not.toBeInTheDocument()

  await act(async () => {
    workList.resolve([{ origin: 'https://b.test', decisions: { camera: 'allow' } }])
  })
  expect(screen.getByText('b.test')).toBeInTheDocument()
  fireEvent.change(permissionSelects()[0], { target: { value: 'block' } })
  expect(sitePermissionsSet).toHaveBeenLastCalledWith(
    expect.objectContaining({ profileId: 'work', permission: 'camera', decision: 'block' })
  )
})
