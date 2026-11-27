// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type {
  BrowserBookmarkMutationResult,
  BrowserBookmarksApi
} from '../../../../../shared/browser/bookmarks/browser-bookmarks'
import { BrowserBookmarkEdit } from './BrowserBookmarkEdit'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('keeps a reopened editor and its draft when the previous editor finishes saving', async () => {
  const firstSave = Promise.withResolvers<BrowserBookmarkMutationResult>()
  const mutate = vi
    .fn<BrowserBookmarksApi['mutate']>()
    .mockReturnValueOnce(firstSave.promise)
    .mockResolvedValueOnce('duplicate')
    .mockResolvedValueOnce('saved')
  vi.stubGlobal('api', { browser: { bookmarks: { mutate } } })
  render(
    <TooltipProvider>
      <BrowserBookmarkEdit
        bookmark={{
          id: '0b339b8e-bf94-457a-889b-8f13911ebc93',
          title: 'Original',
          url: 'https://example.org/'
        }}
        scope={[null, 'default']}
      />
    </TooltipProvider>
  )
  const trigger = screen.getByRole('button', { name: 'Edit bookmark' })
  fireEvent.click(trigger)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'First draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(trigger)
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New draft' } })
  fireEvent.change(screen.getByLabelText('Address'), { target: { value: 'https://example.net/' } })
  await act(async () => {
    firstSave.resolve('saved')
  })
  expect(screen.getByDisplayValue('New draft')).toBeTruthy()
  expect(screen.getByDisplayValue('https://example.net/')).toBeTruthy()

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
  expect(screen.getByRole('alert')).toBeTruthy()
  expect(screen.getByDisplayValue('New draft')).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  })
  expect(screen.queryByRole('dialog')).toBeNull()
})
