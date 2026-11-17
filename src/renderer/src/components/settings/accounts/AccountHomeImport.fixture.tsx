import { defineFixture } from '../../../component-fixtures/component-fixture'
import { AccountHomeImportForm } from './AccountHomeImport'

export const claude = defineFixture({
  width: 360,
  render: () => (
    <div className="bg-background p-4 text-foreground">
      <AccountHomeImportForm
        provider="Claude"
        runtime={{ runtime: 'host', label: 'Windows' }}
        disabled={false}
        importAccount={async () => ({})}
        runAction={async (_, operation) => {
          await operation()
        }}
        onImported={() => {}}
      />
    </div>
  )
})
