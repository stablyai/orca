import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { SourceControlSectionFileList } from './section-file-list'
import {
  buildSubmoduleChildEntry,
  injectExpandedSubmoduleRows,
  type RenderableSourceControlNode,
  type SubmoduleSectionTreeNode
} from './submodule-expansion'

const parent: SubmoduleSectionTreeNode & { type: 'file' } = {
  type: 'file',
  key: 'unstaged::dependency',
  path: 'dependency',
  name: 'dependency',
  area: 'unstaged',
  depth: 0,
  entry: {
    path: 'dependency',
    area: 'unstaged',
    status: 'modified',
    submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: true }
  }
}
const innerEntries: GitStatusEntry[] = [
  { path: 'src/index.ts', area: 'staged', status: 'modified' },
  { path: 'tests/index.ts', area: 'untracked', status: 'untracked' }
]
const expanded = new Set(['unstaged::dependency'])

function expandedRows(error?: string, refreshing?: boolean) {
  return injectExpandedSubmoduleRows(
    [parent],
    expanded,
    {
      'unstaged::dependency': {
        status: 'loaded',
        entries: innerEntries,
        ...(error ? { error, refreshing } : {})
      }
    },
    'Loading submodule changes…',
    'No changes in submodule'
  )
}

function SubmoduleRows({ rows }: { rows: RenderableSourceControlNode[] }) {
  return (
    <SourceControlSectionFileList
      sourceControlViewMode="tree"
      treeRows={rows}
      listRows={[]}
      fileListScrollElement={null}
      normalizedFilter=""
      isExecutingBulk={false}
      collapsedTreeDirs={new Set()}
      toggleTreeDir={() => {}}
      requestDiscardPaths={() => {}}
      handleStageAllPaths={async () => {}}
      handleUnstagePaths={async () => {}}
      expandedSubmoduleKeys={expanded}
      toggleSubmodule={() => {}}
      retrySubmodule={() => {}}
      currentWorktreeId="fixture-submodule"
      worktreePath="/repo"
      selectedKeySet={new Set()}
      activeOpenRowKeys={new Set()}
      handleSelect={() => {}}
      handleContextMenu={() => {}}
      revealInExplorer={() => {}}
      activeConnectionId={null}
      handleOpenDiff={() => {}}
      handleStage={async () => {}}
      handleResolveConflict={async () => {}}
      handleUnstage={async () => {}}
      requestDiscardEntry={() => {}}
      diffCommentCountByPath={new Map()}
    />
  )
}

export const beforeFlatChildren = defineFixture({
  width: 360,
  render: () => (
    <SubmoduleRows
      rows={[
        parent,
        ...innerEntries.map((innerEntry): SubmoduleSectionTreeNode => {
          const entry = buildSubmoduleChildEntry(parent.path, innerEntry, parent.area)
          return {
            type: 'file',
            key: `${entry.area}::${entry.path}`,
            name: 'index.ts',
            path: entry.path,
            area: entry.area,
            entry,
            depth: 1
          }
        })
      ]}
    />
  )
})

export const afterFolders = defineFixture({
  width: 360,
  render: () => <SubmoduleRows rows={expandedRows()} />
})

export const retainedError = defineFixture({
  width: 360,
  render: () => <SubmoduleRows rows={expandedRows('Unable to refresh submodule changes')} />
})

export const retryPending = defineFixture({
  width: 360,
  render: () => <SubmoduleRows rows={expandedRows('Unable to refresh submodule changes', true)} />
})
