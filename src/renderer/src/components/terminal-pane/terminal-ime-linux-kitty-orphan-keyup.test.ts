// @vitest-environment happy-dom
// Kitty event reporting (flag 2) turns every keyup xterm sees into a release report. IME-consumed
// keys produce keyups whose press xterm never encoded; those must not reach the app as releases.
import { describe, expect, it } from 'vitest'
import sogouGtkTrace from './__fixtures__/fcitx4-sogou-gtk-im-module-trace.json'
import fcitx5Trace from './__fixtures__/fcitx5-hangul-mixed-ascii-terminal-trace.json'
import ibusTrace from './__fixtures__/ibus-hangul-mixed-ascii-terminal-trace.json'
import {
  replayThroughLinuxPane,
  useLinuxPaneTestEnvironment,
  type RecordedDomEvent
} from './terminal-ime-linux-pane-replay-fixture'

const KITTY_FLAGS_3 = '\x1b[>3u'
const releaseOf = (codePoint: number): string => `\x1b[${codePoint};1:3u`

function releases(emitted: string): string[] {
  return emitted.split('\x1b[').flatMap((chunk) => {
    const report = /^\d+;1:3u/.exec(chunk)
    return report ? [`\x1b[${report[0]}`] : []
  })
}

describe('kitty release reports for IME-consumed keys', () => {
  useLinuxPaneTestEnvironment()

  it('sends no release for fcitx4 Sogou letters that arrived as keyups only', async () => {
    const events = sogouGtkTrace.events.filter((event) => event.scenario === 's1_ni_space')
    const { emitted } = await replayThroughLinuxPane(events, KITTY_FLAGS_3)
    expect(emitted).not.toContain(releaseOf('n'.charCodeAt(0)))
    expect(emitted).not.toContain(releaseOf('i'.charCodeAt(0)))
    expect(emitted.startsWith('你')).toBe(true)
    // The pick's Space press was claimed by the native text forwarder, which owes its release.
    expect(releases(emitted)).toEqual([releaseOf(32)])
  })

  it('keeps press and release pairs for plain ASCII typed with the IME off', async () => {
    const events = sogouGtkTrace.events.filter((event) => event.scenario === 's4_ascii_im_off')
    const { emitted } = await replayThroughLinuxPane(events, KITTY_FLAGS_3)
    expect(emitted).toBe(`l${releaseOf(108)}s${releaseOf(115)} ${releaseOf(32)}7${releaseOf(55)}`)
  })

  it.each([
    ['IBus', ibusTrace.dom],
    ['fcitx5', fcitx5Trace.dom]
  ])('sends releases only for keys whose press reached the app under %s Hangul', async (_, dom) => {
    // One 한abc글 repetition: the Hangul jamo are Process/229 presses with real-key keyups.
    const firstEnter = dom.findIndex((event) => event.type === 'keyup' && event.keyCode === 13)
    const events: RecordedDomEvent[] = dom.slice(0, firstEnter + 1)
    const { emitted } = await replayThroughLinuxPane(events, KITTY_FLAGS_3)
    // HangulMode toggles on a Process/229 press, so its keyup (code AltRight / Lang1) has no press to end.
    expect(releases(emitted)).toEqual([])
    // The ASCII run was recorded under a legacy xterm that cancelled its text, so it can't replay here.
    expect(emitted).toBe('한글\r')
  })

  it('suppresses the release of a key held across a focus change', async () => {
    const heldAcrossFocus: RecordedDomEvent[] = [
      { type: 'keyup', key: 'x', code: 'KeyX', keyCode: 88 },
      { type: 'keydown', key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
      { type: 'keyup', key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 }
    ]
    const { emitted } = await replayThroughLinuxPane(heldAcrossFocus, KITTY_FLAGS_3)
    // The arrow xterm encodes itself still gets its press and release.
    expect(emitted).toBe('\x1b[A\x1b[1;1:3A')
  })
})
