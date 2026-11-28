import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { FileExplorerSortModeSetting } from './FileExplorerSortModeSetting'

const settings = {
  ...getDefaultSettings('/home/test'),
  fileExplorerSortMode: 'files-first' as const
}

export const filesFirst = defineFixture({
  width: 760,
  store: { settings },
  render: () => <FileExplorerSortModeSetting settings={settings} updateSettings={() => {}} />
})
