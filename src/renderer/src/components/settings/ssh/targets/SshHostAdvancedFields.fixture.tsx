import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { SshHostAdvancedFields } from './SshHostAdvancedFields'
import { EMPTY_FORM } from './ssh-target-draft'

const noop = (): void => {}

/** The per-host browser control setting and what it covers. */
export const browserControlSetting = defineFixture({
  width: 560,
  render: () => (
    <div className="grid grid-cols-2 gap-3 p-4">
      <SshHostAdvancedFields
        offerReconnectOnLaunch
        open
        onOpenChange={noop}
        form={EMPTY_FORM}
        disabled={false}
        onFormChange={noop}
      />
    </div>
  )
})
