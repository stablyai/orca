// A preview tab's promotion in a layout-owner build when main routes a twin workspace's tab to a
// paired server (host_not_owned): the window ends the preview in its own copy, as the switch-off
// window does for every tab.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import type { AppState } from '../../types'
import type { LayoutCommandResult } from '../../../../../shared/workspace-layout/workspace-layout-command-types'

type Answer = 'asToday' | 'apply' | 'refused'
const answer = vi.hoisted((): { value: Answer } => ({ value: 'asToday' }))

vi.mock('@/lib/resolve-owner', () => ({ runtimeEnvironmentIdUnlessTwin: () => null }))
vi.mock('@/runtime/layout-apply-send', () => ({
  sendLayoutApply: (
    _state: unknown,
    _worktreeId: string,
    _command: unknown,
    handlers: {
      apply: (result: LayoutCommandResult) => void
      asToday: () => void
      refused?: () => void
    }
  ) => {
    if (answer.value === 'asToday') {
      handlers.asToday()
    } else if (answer.value === 'apply') {
      handlers.apply({})
    } else {
      handlers.refused?.()
    }
    return true
  }
}))

const { promotePreviewTabsThroughLayoutOwner } = await import('./preview-tab-promotion')

const WT = 'repo::/twin'

function previewTab(id: string): Tab {
  return {
    id,
    entityId: `/twin/${id}.ts`,
    groupId: 'g1',
    worktreeId: WT,
    contentType: 'editor',
    label: `${id}.ts`,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPreview: true
  }
}

function promote(id: string): Tab {
  let tabs: AppState['unifiedTabsByWorktree'] = { [WT]: [previewTab(id)] }
  const set = (
    update: (
      state: Pick<AppState, 'unifiedTabsByWorktree'>
    ) => Partial<Pick<AppState, 'unifiedTabsByWorktree'>>
  ): void => {
    tabs = update({ unifiedTabsByWorktree: tabs }).unifiedTabsByWorktree ?? tabs
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked sender and owner lookup read nothing from the state.
  promotePreviewTabsThroughLayoutOwner({} as AppState, set, [{ id, worktreeId: WT }])
  return tabs[WT]![0]!
}

describe.runIf(ORCA_LAYOUT_OWNER_IS_MAIN)(
  'preview promotion of a twin tab, layout-owner build',
  () => {
    beforeEach(() => {
      answer.value = 'asToday'
    })

    it('ends the preview here when main routes the tab to a paired server', () => {
      expect(promote('routed').isPreview).toBeUndefined()
    })

    it("leaves the flag to main's frame when main promotes it, and keeps it on a refusal", () => {
      answer.value = 'apply'
      expect(promote('applied').isPreview).toBe(true)
      answer.value = 'refused'
      expect(promote('refused').isPreview).toBe(true)
    })
  }
)
