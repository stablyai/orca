// @vitest-environment happy-dom
// HarmonyOS PC ArkWeb (Huawei Browser + Celia pinyin) commits with no composition events.
import { describe, expect, it } from 'vitest'
import {
  replayThroughLinuxPane,
  useLinuxPaneTestEnvironment,
  type RecordedDomEvent
} from './terminal-ime-linux-pane-replay-fixture'

const ARKWEB_PC_UA =
  'Mozilla/5.0 (PC; OpenHarmony 6.1; Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36  ArkWeb/6.1.0.134 HuaweiBrowser/6.1.9.300'

// Recorded on a MateBook Pro typing "nihao" then Space: letters arrive as keyups only.
const NIHAO_SPACE_TRACE: RecordedDomEvent[] = [
  { type: 'keyup', key: 'n', code: 'KeyN', keyCode: 78, value: '' },
  { type: 'keyup', key: 'i', code: 'KeyI', keyCode: 73, value: '' },
  { type: 'keyup', key: 'h', code: 'KeyH', keyCode: 72, value: '' },
  { type: 'keydown', key: '\u0000', code: '', keyCode: 229, value: '' },
  { type: 'beforeinput', inputType: 'insertText', data: '你好', value: '' },
  { type: 'input', inputType: 'insertText', data: '你好', value: '你好' },
  { type: 'keyup', key: '\u0000', code: '', keyCode: 229, value: '你好' },
  { type: 'keyup', key: ' ', code: 'Space', keyCode: 32, value: '你好' }
]

describe('HarmonyOS ArkWeb IME commits', () => {
  useLinuxPaneTestEnvironment(ARKWEB_PC_UA)

  it.each([
    ['no kitty protocol', null],
    ['kitty disambiguate', '\x1b[>1u'],
    ['kitty all keys as escapes with event types', '\x1b[>11u']
  ])('sends the committed text once under %s', async (_, kittyPush) => {
    const { emitted } = await replayThroughLinuxPane(NIHAO_SPACE_TRACE, kittyPush)
    expect(emitted).toBe('你好')
  })
})
