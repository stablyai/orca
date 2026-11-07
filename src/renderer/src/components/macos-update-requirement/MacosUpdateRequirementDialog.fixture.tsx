import { defineFixture } from '../../component-fixtures/component-fixture'
import { MacosUpdateRequirementDialog } from './MacosUpdateRequirementDialog'

const requirement = { version: '1.5.0', minimumMacosVersion: '13.4' }

function fixture(support: 'supported' | 'unsupported' | 'unknown' | undefined) {
  return defineFixture({
    render: () => (
      <MacosUpdateRequirementDialog
        open
        onOpenChange={() => {}}
        requirement={requirement}
        support={support}
        onOpenUrl={() => {}}
      />
    )
  })
}

export const canUpgrade = fixture('supported')
export const cannotUpgrade = fixture('unsupported')
export const unknown = fixture('unknown')
export const checking = fixture(undefined)
