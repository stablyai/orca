import { defineFixture } from '../../../component-fixtures/component-fixture'
import { ZotzWorkingRipple } from './ZotzWorkingRipple'
import { ZotzBackgroundSonar } from './ZotzBackgroundSonar'

export const working = defineFixture({
  width: 200,
  render: () => (
    <div className="flex items-center gap-2 bg-worktree-sidebar p-4 text-sm">
      <ZotzWorkingRipple />
      <span>Mejorar vistas</span>
    </div>
  )
})

export const backgroundOnly = defineFixture({
  width: 200,
  render: () => (
    <div className="flex items-center gap-2 bg-worktree-sidebar p-4 text-sm">
      <ZotzBackgroundSonar />
      <span>Verificar datos</span>
    </div>
  )
})
