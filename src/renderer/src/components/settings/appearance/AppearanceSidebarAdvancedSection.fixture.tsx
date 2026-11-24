import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { AppearanceSidebarAdvancedSection } from './AppearanceSidebarAdvancedSection'

const noop = () => {}

function makeSettings(startChildWorkspacesCollapsed: boolean) {
  return {
    ...getDefaultSettings('/home/fixture'),
    startChildWorkspacesCollapsed
  }
}

export const defaultOff = defineFixture({
  width: 640,
  render: () => (
    <AppearanceSidebarAdvancedSection
      settings={makeSettings(false)}
      updateSettings={noop}
      setWorktreeCardMode={noop}
    />
  )
})

export const startCollapsedOn = defineFixture({
  width: 640,
  render: () => (
    <AppearanceSidebarAdvancedSection
      settings={makeSettings(true)}
      updateSettings={noop}
      setWorktreeCardMode={noop}
    />
  )
})
