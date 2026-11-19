import { FEATURE_TIPS } from '../../../../shared/feature-education/feature-tips'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { CmdJPaletteTipDialog } from './CmdJPaletteTipDialog'

const tip = FEATURE_TIPS.find((item) => item.id === 'cmd-j-palette')
if (!tip) {
  throw new Error('cmd-j-palette feature tip is missing')
}

export const open = defineFixture({
  render: () => (
    <CmdJPaletteTipDialog
      open
      tip={tip}
      primaryBusy={false}
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onSkip={() => {}}
      onRebindClick={() => {}}
    />
  )
})
