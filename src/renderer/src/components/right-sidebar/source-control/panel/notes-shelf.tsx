import { SourceControlNotesShelf } from '../notes/notes-shelf'
import type { SourceControlPanelModel } from './use-panel-model'

export function SourceControlPanelNotesShelf({
  model
}: {
  model: SourceControlPanelModel
}): React.JSX.Element | null {
  const {
    activeGroupId,
    activeWorktreeId,
    deleteDiffComment,
    diffCommentCount,
    diffCommentsCopied,
    diffCommentsExpanded,
    diffCommentsForActive,
    handleCopyDiffComments,
    handleOpenComment,
    setDiffCommentsExpanded,
    setPendingDiffCommentsClear,
    worktreePath
  } = model

  if (!activeWorktreeId || !worktreePath || diffCommentCount === 0) {
    return null
  }

  return (
    <SourceControlNotesShelf
      activeWorktreeId={activeWorktreeId}
      activeGroupId={activeGroupId}
      diffCommentsForActive={diffCommentsForActive}
      diffCommentCount={diffCommentCount}
      diffCommentsExpanded={diffCommentsExpanded}
      setDiffCommentsExpanded={setDiffCommentsExpanded}
      diffCommentsCopied={diffCommentsCopied}
      handleCopyDiffComments={handleCopyDiffComments}
      setPendingDiffCommentsClear={setPendingDiffCommentsClear}
      deleteDiffComment={deleteDiffComment}
      handleOpenComment={handleOpenComment}
    />
  )
}
