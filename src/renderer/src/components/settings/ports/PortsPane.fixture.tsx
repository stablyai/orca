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

export const invalidRange = defineFixture({
  width: 640,
  render: () => <PortsPane settings={settings} />,
  interact: async (frame) => {
    const input = frame.querySelector<HTMLInputElement>('input[aria-label="Lowest port"]')
    if (!input) {
      return
    }
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setValue?.call(input, '70000')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.focus()
    input.blur()
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
  }
})
