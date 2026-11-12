import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { RepositoryHookCommandSourceSetting } from './RepositoryHookPolicySettings'

export const advancedOpen = defineFixture({
  width: 720,
  render: () => (
    <RepositoryHookCommandSourceSetting
      searchQuery=""
      selectedPolicy="run-both"
      yamlState="loaded"
      yamlHooks={{ scripts: { setup: 'pnpm install' } }}
      copiedTemplate={false}
      isAdvancedOpen
      onSelectPolicy={() => {}}
      onCopyTemplate={() => {}}
      onAdvancedOpenChange={() => {}}
    />
  )
})
