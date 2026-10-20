// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RecoveredEditorDraft } from '../../../../shared/workspace-session-state-types'

const mocks = vi.hoisted(
  (): {
    toast: ReturnType<typeof vi.fn>
    dismiss: ReturnType<typeof vi.fn>
    drafts: RecoveredEditorDraft[]
  } => ({ toast: vi.fn(), dismiss: vi.fn(), drafts: [] })
)

vi.mock('sonner', () => ({
  toast: Object.assign(mocks.toast, { dismiss: mocks.dismiss })
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: { recoveredEditorDrafts: RecoveredEditorDraft[] }) => unknown) =>
      selector({ recoveredEditorDrafts: mocks.drafts }),
    { getState: () => ({ dismissRecoveredEditorDraft: vi.fn() }) }
  )
}))

import { RecoveredEditorDraftsNotice } from './RecoveredEditorDraftsNotice'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  mocks.toast.mockReset()
})

it('offers recovered drafts from an earlier session in one lasting toast', () => {
  mocks.drafts = [
    { filePath: '/repo/a.ts', worktreeId: 'wt', draft: 'one', recoveredAt: 1 },
    { filePath: '/repo/b.ts', worktreeId: 'wt', draft: 'two', recoveredAt: 2 }
  ]

  act(() => root.render(<RecoveredEditorDraftsNotice />))

  expect(mocks.toast).toHaveBeenCalledWith(
    'Recovered 2 unsaved draft(s) from an earlier session',
    expect.objectContaining({ id: 'recovered-editor-drafts', duration: Infinity })
  )
})

it('shows nothing when no draft was recovered', () => {
  mocks.drafts = []

  act(() => root.render(<RecoveredEditorDraftsNotice />))

  expect(mocks.toast).not.toHaveBeenCalled()
})

it('shows the notice again for a draft recovered after the user closed it', () => {
  const first = { filePath: '/repo/a.ts', worktreeId: 'wt', draft: 'one', recoveredAt: 1 }
  mocks.drafts = [first]
  act(() => root.render(<RecoveredEditorDraftsNotice />))
  act(() => mocks.toast.mock.calls.at(-1)?.[1]?.onDismiss())
  mocks.toast.mockClear()

  mocks.drafts = [first, { ...first, filePath: '/repo/b.ts', recoveredAt: 2 }]
  act(() => root.render(<RecoveredEditorDraftsNotice />))

  expect(mocks.toast).toHaveBeenCalledWith(
    'Recovered 1 unsaved draft(s) from an earlier session',
    expect.anything()
  )
})
