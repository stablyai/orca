import { defineFixture } from '../../component-fixtures/component-fixture'
import { ClaudePaneAccountChip } from './ClaudePaneAccountBadge'

export const chip = defineFixture({
  width: 360,
  render: () => (
    <div className="flex items-center rounded-md border border-border bg-background px-2 py-1 text-xs">
      <span className="mr-1 min-w-0 truncate">claude</span>
      <ClaudePaneAccountChip label="ada" email="ada@example.com" />
      <ClaudePaneAccountChip label="ada@work" email="ada@work.example" />
    </div>
  )
})
