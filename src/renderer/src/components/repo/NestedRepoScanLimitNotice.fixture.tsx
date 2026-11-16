import { defineFixture } from '../../component-fixtures/component-fixture'
import { Input } from '../ui/input'
import { NestedRepoScanLimitNotice } from './NestedRepoScanLimitNotice'

export const editingGroupName = defineFixture({
  width: 400,
  render: () => (
    <div className="space-y-4 p-4" onContextMenu={(event) => event.preventDefault()}>
      <Input aria-label="Group name" />
      <NestedRepoScanLimitNotice
        scan={{
          selectedPath: '/projects',
          selectedPathKind: 'non_git_folder',
          repos: [],
          truncated: true,
          timedOut: false,
          stopped: false,
          durationMs: 100,
          maxDepth: 5,
          maxRepos: 100,
          timeoutMs: null
        }}
      />
    </div>
  )
})
