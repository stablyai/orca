import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { TerminalInteractionSection } from './TerminalInteractionSection'

const settings = getDefaultSettings('/home/fixture')

export const defaults = defineFixture({
  width: 720,
  render: () => (
    <TerminalInteractionSection settings={settings} updateSettings={() => {}} searchQuery="" />
  )
})

export const scrollOnInputOff = defineFixture({
  width: 720,
  render: () => (
    <TerminalInteractionSection
      settings={{ ...settings, terminalScrollOnUserInput: false }}
      updateSettings={() => {}}
      searchQuery=""
    />
  )
})
