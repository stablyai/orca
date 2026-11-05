import { defineFixture } from '../../component-fixtures/component-fixture'
import { TextGenerationAccountRecoverySetting } from './TextGenerationAccountRecoverySetting'

const update = async () => {}

export const off = defineFixture({
  width: 760,
  render: () => (
    <TextGenerationAccountRecoverySetting remote={false} model={{ settings: {}, update }} />
  )
})

export const on = defineFixture({
  width: 760,
  render: () => (
    <TextGenerationAccountRecoverySetting
      remote={false}
      model={{ settings: { textGenerationSubscriptionFailoverEnabled: true }, update }}
    />
  )
})

export const olderRemoteHost = defineFixture({
  width: 760,
  render: () => <TextGenerationAccountRecoverySetting remote model={{ settings: {}, update }} />
})
