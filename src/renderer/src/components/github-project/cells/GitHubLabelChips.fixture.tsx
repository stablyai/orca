import { defineFixture } from '../../../component-fixtures/component-fixture'
import { GitHubLabelChips } from './ProjectCellValueEditors'

export const narrow = defineFixture({
  width: 150,
  render: () => (
    <GitHubLabelChips
      labels={[
        { name: 'bug', color: 'd73a4a' },
        { name: 'documentation', color: '0075ca' },
        { name: 'good first issue', color: '7057ff' },
        { name: 'help wanted', color: '008672' },
        { name: 'needs review', color: 'ffffff' }
      ]}
    />
  )
})
