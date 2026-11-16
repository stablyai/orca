import { defineFixture } from '../../../component-fixtures/component-fixture'
import { BitbucketCredentialsDialog } from './bitbucket-credentials-dialog'

export const apiToken = defineFixture({
  width: 640,
  render: () => <BitbucketCredentialsDialog open onOpenChange={() => {}} />
})

export const accessToken = defineFixture({
  width: 640,
  render: () => <BitbucketCredentialsDialog open initialAuthMode="token" onOpenChange={() => {}} />
})
