import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { RepositoryIconTabs } from './RepositoryIconTabs'

export const ImageUpload = defineFixture({
  width: 400,
  render: () => (
    <RepositoryIconTabs
      initialTab="avatar"
      selectedLucideName={null}
      selectedEmoji=""
      loadingGitHub={false}
      onSetIcon={() => undefined}
      onUseGitHubAvatar={() => undefined}
    />
  )
})
