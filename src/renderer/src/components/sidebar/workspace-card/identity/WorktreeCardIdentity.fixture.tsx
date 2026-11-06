import type { CSSProperties } from 'react'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  makeRepo,
  makeTerminalTab,
  makeWorktree
} from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from '../surface/WorktreeCard'

const repo = { ...makeRepo(), displayName: 'orca' }
const worktree = makeWorktree('identity-fixture', 'Primary workspace', {
  branch: 'main',
  isMainWorktree: true,
  isSparse: true,
  sparseDirectories: ['src/renderer']
})

const primarySparseFixture = (border?: string) => {
  const style: CSSProperties & { '--host-badge-border'?: string } = {
    '--host-badge-border': border
  }
  return defineFixture({
    width: 320,
    store: {
      settings: {
        ...getDefaultSettings('/home/fixture'),
        experimentalNewWorktreeCardStyle: true
      },
      repos: [repo],
      worktreesByRepo: { [repo.id]: [worktree] },
      worktreeCardProperties: ['status', 'branch', 'host'],
      tabsByWorktree: {
        [worktree.id]: [makeTerminalTab('identity-terminal', worktree.id, 'Shell')]
      },
      ptyIdsByTabId: { 'identity-terminal': ['identity-pty'] }
    },
    render: () => (
      <div className="bg-worktree-sidebar p-2 text-worktree-sidebar-foreground" style={style}>
        <WorktreeCard
          worktree={worktree}
          repo={repo}
          isActive
          hostContextLabel="Local"
          inPinnedSection
          nativeDragEnabled={false}
        />
      </div>
    )
  })
}

export const primarySparse = primarySparseFixture()
export const customHostBorder = primarySparseFixture('#777777')
