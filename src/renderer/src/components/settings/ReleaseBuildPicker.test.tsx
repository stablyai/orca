// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { ReleaseBuild } from '../../../../shared/release-channel'
import { ReleaseBuildPicker } from './ReleaseBuildPicker'

afterEach(cleanup)

const builds: ReleaseBuild[] = Array.from({ length: 100 }, (_, index) => ({
  tag: `v1.4.238-adhoc.20261021${String(index).padStart(4, '0')}`,
  version: `1.4.238-adhoc.20261021${String(index).padStart(4, '0')}`,
  name: `1.4.238 • branch-${index} • Oct 21 • c${String(index).padStart(6, '0')}`,
  channel: 'adhoc',
  publishedAt: null,
  releaseUrl: 'https://example.com/release',
  installerUrl: null
}))

function Picker({ items = builds }: { items?: ReleaseBuild[] }): React.JSX.Element {
  const [selectedTag, setSelectedTag] = useState(items[0]?.tag ?? null)
  return (
    <ReleaseBuildPicker
      builds={items}
      selectedTag={selectedTag}
      onSelect={setSelectedTag}
      disabled={items.length === 0}
      placeholder="No builds found"
    />
  )
}

it('searches a full feed by title, commit, version and tag without changing the selection', async () => {
  render(<Picker />)
  const trigger = screen.getByRole('combobox', { name: 'Build' })
  expect(screen.queryAllByRole('option')).toHaveLength(0)
  fireEvent.click(trigger)
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(100))
  const input = screen.getByRole('combobox', { name: 'Search builds' })

  for (const query of [
    ' BRANCH-99  C000099 ',
    'adhoc.202610210099',
    'v1.4.238-adhoc.202610210099'
  ]) {
    fireEvent.change(input, { target: { value: query } })
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
    expect(screen.getByRole('option').textContent).toContain('branch-99')
    expect(trigger.textContent).toContain('branch-0')
  }

  fireEvent.change(input, { target: { value: '[no match](' } })
  await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0))
  expect(screen.getByText('No matching builds.')).toBeTruthy()

  fireEvent.change(input, { target: { value: '   ' } })
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(100))
})

it('selects a filtered build with the keyboard and resets search when reopened', async () => {
  render(<Picker />)
  const trigger = screen.getByRole('combobox', { name: 'Build' })
  fireEvent.click(trigger)
  const input = screen.getByRole('combobox', { name: 'Search builds' })
  fireEvent.change(input, { target: { value: 'branch-99' } })
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  expect(trigger.textContent).toContain('branch-99')

  fireEvent.click(trigger)
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(100))
  expect(screen.getByRole('combobox', { name: 'Search builds' }).getAttribute('value')).toBe('')
  fireEvent.keyDown(screen.getByRole('combobox', { name: 'Search builds' }), { key: 'Escape' })
  await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'))
  expect(trigger.textContent).toContain('branch-99')
})

it('falls back to the version for an untitled build and disables an empty feed', async () => {
  const untitled = { ...builds[0], name: null, version: '1.4.238', tag: 'v1.4.238' }
  const view = render(<Picker items={[untitled]} />)
  expect(screen.getByRole('combobox', { name: 'Build' }).textContent).toBe('1.4.238')
  fireEvent.click(screen.getByRole('combobox', { name: 'Build' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Search builds' }), {
    target: { value: 'v1.4.238' }
  })
  await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1))
  fireEvent.click(screen.getByRole('option'))
  view.unmount()

  render(<Picker items={[]} />)
  const trigger = screen.getByRole('combobox', { name: 'Build' })
  expect(trigger.hasAttribute('disabled')).toBe(true)
  expect(trigger.textContent).toBe('No builds found')
})
