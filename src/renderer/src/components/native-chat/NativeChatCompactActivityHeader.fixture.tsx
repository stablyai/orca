import { defineFixture } from '../../component-fixtures/component-fixture'
import { getDefaultSettings } from '../../../../shared/constants'
import { NativeChatToolRun } from './NativeChatToolRun'

const command =
  'node scripts/check-a-long-workspace-configuration-and-report-detailed-results.mjs --project workspace --configuration development --verify-all-sources'
const store = { settings: { ...getDefaultSettings('/home/fixture'), uiLanguage: 'en' as const } }
function header() {
  return (
    <div className="native-chat-appearance p-4">
      <NativeChatToolRun
        blocks={[
          {
            type: 'tool-call',
            callId: 'check',
            name: 'Bash',
            input: { command },
            state: 'completed'
          },
          {
            type: 'tool-result',
            callId: 'check',
            output: 'The complete command and its output remain available in this detail.'
          }
        ]}
        expandSignal={false}
      />
    </div>
  )
}
export const collapsed = defineFixture({ store, width: 390, render: header })
export const expanded = defineFixture({
  store,
  width: 390,
  render: header,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-native-chat-tool-run-state]')?.click()
  }
})
export const verified = defineFixture({
  store,
  width: 390,
  render: header,
  interact: async (frame) => {
    await document.fonts.ready
    const toggle = frame.querySelector<HTMLButtonElement>('[data-native-chat-tool-run-state]')
    const label =
      toggle &&
      Array.from(toggle.querySelectorAll('span')).find(
        (node) => node.textContent?.startsWith('node scripts/') && node.children.length === 0
      )
    if (!toggle || !label) {
      throw new Error('The command summary did not render')
    }
    const lineHeight = Number.parseFloat(getComputedStyle(label).lineHeight)
    if (label.getBoundingClientRect().height > lineHeight * 1.1) {
      throw new Error('The activity summary wraps to more than one line')
    }
    if (!toggle.querySelector('svg.lucide-chevron-right')) {
      throw new Error('The activity disclosure caret is missing')
    }
    toggle.click()
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (toggle.getAttribute('aria-expanded') !== 'true') {
      throw new Error('The compact activity header no longer expands')
    }
  }
})
