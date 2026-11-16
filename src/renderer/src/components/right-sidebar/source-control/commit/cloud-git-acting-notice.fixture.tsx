// GH-ACTING-LINE under Commit/Push in a cloud workspace's source control panel.
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { CloudWorkspaceGitActor } from '../../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { CloudGitActingNoticeView } from './cloud-git-acting-notice'

function fixture(answer: CloudWorkspaceGitActor) {
  return defineFixture({
    width: 320,
    render: () => (
      <div className="bg-background p-3">
        <div className="flex h-7 items-center justify-center rounded-md bg-primary text-xs text-primary-foreground">
          Commit &amp; Push
        </div>
        <CloudGitActingNoticeView answer={answer} onConnect={() => {}} />
      </div>
    )
  })
}

export const member = fixture({
  gitActor: { kind: 'member', userId: 'u1', login: 'octo-dev' },
  viewerConnected: true
})
export const botConnect = fixture({
  gitActor: { kind: 'bot', reason: 'no_connected_member' },
  viewerConnected: false
})
export const botStale = fixture({
  gitActor: { kind: 'bot', reason: 'stale' },
  viewerConnected: true
})
