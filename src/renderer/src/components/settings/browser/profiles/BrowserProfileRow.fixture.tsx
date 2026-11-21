import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { ConfirmationDialogContext } from '../../../dismiss/confirmation/confirmation-dialog-context'
import { BrowserProfileRow } from './BrowserProfileRow'

const workSource = {
  browserFamily: 'chrome' as const,
  profileName: 'Work',
  importedAt: 1,
  chromeProfile: { directory: 'Profile 2', id: '228e99e3-ed6b-44d4-ae26-c16141b871c6' }
}

const dismissConfirmation = async (): Promise<boolean> => false

export const work = defineFixture({
  width: 584,
  render: () => (
    <ConfirmationDialogContext.Provider value={dismissConfirmation}>
      <div className="space-y-2 bg-background p-4 text-foreground">
        <BrowserProfileRow
          hostId="local"
          profile={{
            id: 'default',
            scope: 'default',
            partition: '',
            label: 'Default',
            source: null
          }}
          detectedBrowsers={[]}
          importState={null}
          isActive={false}
          isDefault
          onSelect={() => {}}
        />
        <BrowserProfileRow
          hostId="local"
          profile={{
            id: 'work',
            scope: 'imported',
            partition: '',
            label: 'Work sites',
            source: workSource
          }}
          detectedBrowsers={[]}
          importState={null}
          isActive
          onSelect={() => {}}
        />
      </div>
    </ConfirmationDialogContext.Provider>
  )
})
