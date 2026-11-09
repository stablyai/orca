import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/constants'
import { PortsPane } from './PortsPane'

const settings = getDefaultSettings('/Users/me')

export const defaults = defineFixture({
  width: 640,
  render: () => <PortsPane settings={settings} />
})

export const autoForwardOff = defineFixture({
  width: 640,
  render: () => (
    <PortsPane settings={{ ...settings, runtimePortForwarding: { autoForward: false } }} />
  )
})
