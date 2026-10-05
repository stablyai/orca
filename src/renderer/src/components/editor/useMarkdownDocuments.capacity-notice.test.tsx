// @vitest-environment happy-dom
import { act, createElement, StrictMode, Suspense, use } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { MarkdownDocumentListingCapacityError } from '../../../../shared/markdown-document-listing-limits'
import type * as MarkdownDocumentListRequest from './markdown-document-list-request'
import { useMarkdownDocuments } from './useMarkdownDocuments'

const runtime = vi.hoisted(() => ({ list: vi.fn(), toast: vi.fn() }))
const state = {
  settings: {},
  worktreesByRepo: {
    repo: [
      { id: 'a', path: '/owned/a' },
      { id: 'b', path: '/owned/b' }
    ]
  },
  openFile: vi.fn(),
  openMarkdownPreview: vi.fn()
}
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))
vi.mock('sonner', () => ({ toast: { error: runtime.toast } }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/runtime/runtime-file-client', () => ({ statRuntimePath: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', () => ({ settingsForRuntimeOwner: () => ({}) }))
vi.mock('./markdown-document-list-request', async (importOriginal) => ({
  ...(await importOriginal<typeof MarkdownDocumentListRequest>()),
  requestSharedMarkdownDocumentList: runtime.list
}))

const controllers = new Map<string, ReturnType<typeof useMarkdownDocuments>>()
let root: ReturnType<typeof createRoot>
let container: HTMLDivElement
let unmounted = false
const save = vi.fn(async () => true)

function sourceFile(owner: string): OpenFile {
  return {
    id: `${owner}-source`,
    filePath: `/owned/${owner}/source.md`,
    relativePath: 'source.md',
    worktreeId: owner,
    language: 'markdown',
    isDirty: false,
    mode: 'edit'
  }
}

function Hydration({ pending }: { pending?: Promise<void> }) {
  if (pending) {
    use(pending)
  }
  return null
}

function Harness({
  owner = 'a',
  pane = 'first',
  pending
}: {
  owner?: string
  pane?: string
  pending?: Promise<void>
}) {
  controllers.set(pane, useMarkdownDocuments(sourceFile(owner), true, 'source', save))
  return createElement(Hydration, { pending })
}

function controller(pane = 'first') {
  const value = controllers.get(pane)
  if (!value) {
    throw new Error('Missing mounted document controller')
  }
  return value
}

async function render(owner = 'a', pending?: Promise<void>) {
  await act(async () => {
    root.render(
      createElement(Suspense, { fallback: null }, createElement(Harness, { owner, pending }))
    )
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.clearAllMocks()
  controllers.clear()
  runtime.list.mockReset().mockRejectedValue(new MarkdownDocumentListingCapacityError())
  save.mockReset().mockResolvedValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  unmounted = false
})

afterEach(() => {
  if (!unmounted) {
    act(() => root.unmount())
  }
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('shows one useful notice across repeated failed saves without changing successful save results', async () => {
  await render()
  expect(controller().markdownDocuments).toEqual([])
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      expect(await controller().mdSave(`saved-${index}`)).toBe(true)
    })
  }
  expect(save).toHaveBeenCalledTimes(5)
  expect(runtime.toast).toHaveBeenCalledTimes(1)
  expect(runtime.toast).toHaveBeenCalledWith(
    'Markdown links are unavailable because this workspace is too large.',
    { id: expect.stringContaining('markdown-document-capacity:') }
  )
})

it('rearms after an admitted current listing and after changing the committed owner', async () => {
  await render()
  runtime.list.mockResolvedValueOnce([])
  await act(async () => {
    await controller().mdSave('saved')
  })
  await act(async () => {
    await controller().mdSave('saved-again')
  })
  expect(runtime.toast).toHaveBeenCalledTimes(2)
  await render('b')
  expect(runtime.toast).toHaveBeenCalledTimes(3)
  expect(runtime.toast.mock.calls[0][1].id).not.toBe(runtime.toast.mock.calls[2][1].id)
})

it('does not arm a capacity notice for ordinary listing errors or failed saves', async () => {
  runtime.list.mockRejectedValue(new Error('Permission denied'))
  await render()
  expect(runtime.toast).not.toHaveBeenCalled()
  save.mockResolvedValue(false)
  runtime.list.mockRejectedValue(new MarkdownDocumentListingCapacityError())
  await act(async () => {
    expect(await controller().mdSave('not-saved')).toBe(false)
  })
  expect(runtime.list).toHaveBeenCalledTimes(1)
  expect(runtime.toast).not.toHaveBeenCalled()
})

it.each(['owner-change', 'unmount', 'superseded'] as const)(
  'ignores a late capacity failure after %s',
  async (reason) => {
    const pending = Promise.withResolvers<MarkdownDocument[]>()
    runtime.list.mockReturnValueOnce(pending.promise).mockResolvedValue([])
    await render()
    if (reason === 'owner-change') {
      await render('b')
    } else if (reason === 'unmount') {
      act(() => root.unmount())
      unmounted = true
    } else {
      await act(async () => {
        await controller().mdSave('newest')
      })
    }
    await act(async () => {
      pending.reject(new MarkdownDocumentListingCapacityError())
    })
    expect(runtime.toast).not.toHaveBeenCalled()
  }
)

it('keeps one notice while Suspense hides and reveals the same committed editor', async () => {
  await render()
  const pending = Promise.withResolvers<void>()
  await render('a', pending.promise)
  await act(async () => {
    await controller().mdSave('saved-while-hidden')
  })
  await act(async () => {
    pending.resolve()
  })
  expect(runtime.toast).toHaveBeenCalledTimes(1)
  await act(async () => {
    await controller().mdSave('saved-after-reveal')
  })
  expect(runtime.toast).toHaveBeenCalledTimes(1)
})

it('does not notify for a request started from a discarded owner render', async () => {
  runtime.list.mockResolvedValueOnce([])
  await render()
  const pending = Promise.withResolvers<void>()
  await render('b', pending.promise)
  await act(async () => {
    await controller().mdSave('saved-uncommitted-owner')
  })
  expect(runtime.list).toHaveBeenCalledTimes(1)
  expect(runtime.toast).not.toHaveBeenCalled()
  await render()
})

it('uses one stable Sonner ID for split panes and does not dismiss another pane on close', async () => {
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        createElement(Harness, { pane: 'first' }),
        createElement(Harness, { pane: 'second' })
      )
    )
  })
  expect(runtime.toast).toHaveBeenCalledTimes(2)
  expect(runtime.toast.mock.calls[0][1].id).toBe(runtime.toast.mock.calls[1][1].id)
  await act(async () => {
    root.render(createElement('div', null, createElement(Harness, { pane: 'second' })))
  })
  expect(runtime.toast).toHaveBeenCalledTimes(2)
})

it('shows one notice after Strict Mode replays mount effects', async () => {
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Harness)))
  })
  expect(runtime.toast).toHaveBeenCalledTimes(1)
})
