import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { ChatUiHereTipDialog } from './ChatUiHereTipDialog'

const tip = FEATURE_TIPS.find((item) => item.id === 'chat-ui-here')
if (!tip) {
  throw new Error('Chat UI feature tip is missing')
}

export const chatOff = defineFixture({
  render: () => (
    <ChatUiHereTipDialog
      open
      tip={tip}
      variant="chat-ui-off"
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onSkip={() => {}}
      onSettingsClick={() => {}}
    />
  )
})

export const chatOn = defineFixture({
  render: () => (
    <ChatUiHereTipDialog
      open
      tip={tip}
      variant="chat-ui-on"
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onSkip={() => {}}
      onSettingsClick={() => {}}
    />
  )
})

export const chatOffSwappedButtons = defineFixture({
  render: () => (
    <ChatUiHereTipDialog
      open
      tip={tip}
      variant="chat-ui-off"
      swapButtons
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onSkip={() => {}}
      onSettingsClick={() => {}}
    />
  )
})

export const chatOnSwappedButtons = defineFixture({
  render: () => (
    <ChatUiHereTipDialog
      open
      tip={tip}
      variant="chat-ui-on"
      swapButtons
      onOpenChange={() => {}}
      onPrimaryAction={() => {}}
      onSkip={() => {}}
      onSettingsClick={() => {}}
    />
  )
})
