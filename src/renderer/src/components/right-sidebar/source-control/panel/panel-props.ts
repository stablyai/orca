import type { SourceControlPanelModel } from './use-panel-model'

export type SourceControlPanelReadyProps = {
  activeRepo: NonNullable<SourceControlPanelModel['activeRepo']>
  activeWorktree: NonNullable<SourceControlPanelModel['activeWorktree']>
  currentWorktreeId: string
  model: SourceControlPanelModel
  worktreePath: string
}
