// GH-ACTING-LINE under Commit/Push in a cloud workspace's source control panel.
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { CloudGitActing } from '@/components/cloud-workspaces/cloud-git-acting-copy'
import { CloudGitActingNoticeView } from './cloud-git-acting-notice'

function fixture(answer: CloudGitActing) {
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

export const owner = fixture({
  githubActing: { actingAs: 'member', userId: 'u1', login: 'octo-dev' },
  you: { connected: true, login: 'octo-dev' }
})
export const botConnect = fixture({
  githubActing: { actingAs: 'bot', reason: 'reconnect' },
  you: { connected: false }
})
export const transferred = fixture({
  githubActing: { actingAs: 'bot', reason: 'transferred' },
  you: { connected: false }
})
