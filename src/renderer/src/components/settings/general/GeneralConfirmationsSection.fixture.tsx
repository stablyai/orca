import { defineFixture } from '../../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { GeneralConfirmationsSection } from './GeneralConfirmationsSection'

const store = { settings: { ...getDefaultSettings('/tmp'), uiLanguage: 'en' as const } }

function Section({ confirmCloseIdleTabs }: { confirmCloseIdleTabs: boolean }): React.JSX.Element {
  return (
    <div className="p-4">
      <GeneralConfirmationsSection
        settings={{ ...getDefaultSettings('/tmp'), confirmCloseIdleTabs }}
        updateSettings={() => {}}
      />
    </div>
  )
}

export const idleOff = defineFixture({
  store,
  width: 760,
  render: () => <Section confirmCloseIdleTabs={false} />
})

export const idleOn = defineFixture({
  store,
  width: 760,
  render: () => <Section confirmCloseIdleTabs />
})
