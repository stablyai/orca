import { defineFixture } from '../../component-fixtures/component-fixture'
import { FullDiskAccessNudgeToast } from './FullDiskAccessNudgeToast'

const noop = (): void => {}

export const singlePrompt = defineFixture({
  width: 448,
  render: () => (
    <FullDiskAccessNudgeToast
      promptCount={1}
      onEnable={noop}
      onClose={noop}
      onDontShowAgain={noop}
    />
  )
})

export const repeatedPrompts = defineFixture({
  width: 448,
  render: () => (
    <FullDiskAccessNudgeToast
      promptCount={3}
      onEnable={noop}
      onClose={noop}
      onDontShowAgain={noop}
    />
  )
})

export const narrowWindow = defineFixture({
  width: 300,
  render: () => (
    <FullDiskAccessNudgeToast
      promptCount={3}
      onEnable={noop}
      onClose={noop}
      onDontShowAgain={noop}
    />
  )
})

export const mediumWindow = defineFixture({
  width: 360,
  render: () => (
    <FullDiskAccessNudgeToast
      promptCount={1}
      onEnable={noop}
      onClose={noop}
      onDontShowAgain={noop}
    />
  )
})
