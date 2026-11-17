import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { SourceControlHeaderOverflowMenu } from './header-overflow-menu'

const panelActions = {
  sourceControlViewMode: 'list' as const,
  viewModeToggleDisabled: false,
  onToggleViewMode: () => {},
  onChangeBaseRef: () => {},
  onRefreshBranchCompare: () => {},
  branchCompareRefreshDisabled: false,
  diffCommentCount: 2,
  onExpandNotes: () => {},
  onReviewChanges: () => {}
}

function openMenu(frame: HTMLElement): Promise<void> {
  frame.querySelector('button[aria-label="More source control actions"]')?.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      pointerType: 'mouse'
    })
  )
  return new Promise((resolve) => setTimeout(resolve, 120))
}

function Frame() {
  return (
    <div className="flex h-[260px] justify-end bg-sidebar p-2 text-foreground">
      <SourceControlHeaderOverflowMenu panelActions={panelActions} />
    </div>
  )
}

export const openMenuWithReviewChanges = defineFixture({
  width: 320,
  render: () => <Frame />,
  interact: openMenu
})
