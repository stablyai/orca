import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { BitbucketAuthMode } from '../../../../../shared/bitbucket/bitbucket-credentials'
import { BitbucketCredentialsDialog } from './bitbucket-credentials-dialog'

function credentialsFixture(initialAuthMode: BitbucketAuthMode) {
  return defineFixture({
    width: 640,
    render: () => (
      <div className="h-[580px] bg-background">
        <BitbucketCredentialsDialog
          open
          onOpenChange={() => {}}
          initialAuthMode={initialAuthMode}
        />
      </div>
    )
  })
}

export const apiToken = credentialsFixture('basic')
export const accessToken = credentialsFixture('token')
