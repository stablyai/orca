import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { RepositoryHookScriptSetting } from './RepositoryHookScriptSetting'

export const environmentHelp = defineFixture({
  width: 420,
  render: () => (
    <RepositoryHookScriptSetting
      field={{
        name: 'setup',
        label: 'Setup',
        description: 'Run when a workspace is created.',
        placeholder: 'pnpm install'
      }}
      value=""
      hasShared={false}
      sharedScript={undefined}
      onChange={() => {}}
      onCommit={() => {}}
    />
  ),
  interact: (frame) => {
    frame.querySelector('summary')?.click()
  }
})

export const collapsedEnvironmentHelp = defineFixture({ ...environmentHelp, interact: undefined })
