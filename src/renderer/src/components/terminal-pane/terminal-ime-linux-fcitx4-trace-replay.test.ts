// @vitest-environment happy-dom
// Replay Ubuntu/X11 fcitx4 captures through real xterm: Sogou panel picks arrive as plain Space/digit input, while Google Pinyin uses composition sessions (#28213).
import { describe, expect, it } from 'vitest'
import sogouGtkTrace from './__fixtures__/fcitx4-sogou-gtk-im-module-trace.json'
import sogouXimTrace from './__fixtures__/fcitx4-sogou-xim-trace.json'
import googlePinyinTrace from './__fixtures__/fcitx4-googlepinyin-client-preedit-trace.json'
import {
  replayThroughLinuxPane,
  useLinuxPaneTestEnvironment,
  type RecordedDomEvent
} from './terminal-ime-linux-pane-replay-fixture'

type RecordedTrace = { events: (RecordedDomEvent & { scenario: string })[] }

const EXPECTED_BY_SCENARIO = {
  s1_ni_space: '你',
  s2_hao_3: '浩',
  s3_nihao_space: '你好',
  s4_ascii_im_off: 'ls 7'
}

const TRACES: [string, RecordedTrace][] = [
  ['Sogou via the fcitx GTK module', sogouGtkTrace],
  ['Sogou via XIM', sogouXimTrace],
  ['Google Pinyin with an in-client preedit', googlePinyinTrace]
]

describe.each(TRACES)('fcitx4 %s', (_label, trace) => {
  useLinuxPaneTestEnvironment()

  // Kitty flags 1/5 let xterm cancel printable keydown before keypress can deliver the candidate.
  describe.each([
    ['legacy keyboard', null],
    ['kitty flags 1', '\x1b[>1u'],
    ['kitty flags 5', '\x1b[>5u']
  ])('%s', (_mode, kittyPush) => {
    it.each(Object.entries(EXPECTED_BY_SCENARIO))(
      '%s sends exactly the committed text',
      async (scenario, expected) => {
        const events = trace.events.filter((event) => event.scenario === scenario)
        const { emitted } = await replayThroughLinuxPane(events, kittyPush)
        expect(emitted).toBe(expected)
      }
    )
  })
})

// A kitty release report ends in `;<mods>:3u`; no modifiers are held in these recordings.
const KITTY_RELEASE_SUFFIX = ';1:3u'

describe('fcitx4 Sogou via XIM under kitty event reporting', () => {
  useLinuxPaneTestEnvironment()

  // XIM’s empty-code pick press must pair with its real-key release; otherwise the next pick emits two releases.
  it('reports one release per pick', async () => {
    const events = sogouXimTrace.events.filter(
      (event) => event.scenario === 's1_ni_space' || event.scenario === 's2_hao_3'
    )
    const { emitted } = await replayThroughLinuxPane(events, '\x1b[>3u')
    const releasesAfter = (glyph: string, until: number): number =>
      emitted.slice(emitted.indexOf(glyph) + 1, until).split(KITTY_RELEASE_SUFFIX).length - 1
    // Only the first pick's Space; the second round's letters reached the page as keyups only.
    expect(releasesAfter('你', emitted.indexOf('浩'))).toBe(1)
    expect(releasesAfter('浩', emitted.length)).toBe(1)
  })
})
