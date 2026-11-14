import { defineFixture } from '../../../component-fixtures/component-fixture'
import { PluginsOffState } from './PluginsOffState'

export const off = defineFixture({
  width: 720,
  render: () => (
    <div className="bg-background p-5 text-foreground">
      <PluginsOffState />
    </div>
  )
})
