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

export const member = fixture({
  githubActing: { actingAs: 'member', userId: 'u1', login: 'octo-dev' },
  you: { connected: true, login: 'octo-dev' }
})
export const botConnect = fixture({
  githubActing: { actingAs: 'bot', reason: 'sender_not_connected' },
  you: { connected: false }
})
export const noSenderYet = fixture({
  githubActing: { actingAs: 'bot', reason: 'no_sender_yet' },
  you: { connected: true }
})
export const windowExpired = fixture({
  githubActing: { actingAs: 'bot', reason: 'window_expired' },
  you: { connected: true }
})
