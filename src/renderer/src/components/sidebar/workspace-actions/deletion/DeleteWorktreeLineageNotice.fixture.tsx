import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { DeleteWorktreeLineageNotice } from './DeleteWorktreeLineageNotice'

const child: Worktree = {
  id: 'repo::/workspaces/feature-child',
  instanceId: 'child-instance',
  repoId: 'repo',
  path: '/workspaces/feature-child',
  displayName: 'Review the workspace deletion flow',
  head: 'abc123',
  branch: 'feature-child',
  isBare: false,
  isMainWorktree: false,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

function LineageNotice({ initialPreserve = false, canPreserve = true }) {
  const [preserve, setPreserve] = useState(initialPreserve)
  return (
    <DeleteWorktreeLineageNotice
      descendants={[child]}
      dirtyChangeCountsByWorktreeId={new Map([[child.id, 3]])}
      dirtyChangePreviewsByWorktreeId={new Map()}
      preserveChildren={preserve}
      canPreserveChildren={canPreserve}
      disabled={false}
      onPreserveChildrenChange={setPreserve}
    />
  )
}

export const deleteChildren = defineFixture({ width: 400, render: () => <LineageNotice /> })
export const keepChildren = defineFixture({
  width: 400,
  render: () => <LineageNotice initialPreserve />
})
export const nestedChildren = defineFixture({
  width: 400,
  render: () => <LineageNotice canPreserve={false} />
})
