import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import { TextGenerationAccountFailoverSetting } from './TextGenerationAccountFailoverSetting'

const settings = getDefaultSettings('/Users/test')
const local = { target: { kind: 'local' }, available: true } as const

export const off = defineFixture({
  width: 640,
  store: { settings },
  render: () => <TextGenerationAccountFailoverSetting hostScope={local} />
})

export const on = defineFixture({
  width: 640,
  store: { settings: { ...settings, textGenerationSubscriptionFailoverEnabled: true } },
  render: () => <TextGenerationAccountFailoverSetting hostScope={local} />
})
