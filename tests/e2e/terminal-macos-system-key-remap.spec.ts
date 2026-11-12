/**
 * Headless end-to-end coverage for a macOS system-wide key remap reaching the terminal.
 *
 * macOS lets a user rewrite what a physical key inserts by declaring it in
 * `~/Library/KeyBindings/DefaultKeyBinding.dict`. The reported case is a Korean-source user who
 * remaps the ₩ key back to a backquote:
 *
 *     { "₩" = ("insertText:", "`"); "~₩" = ("insertText:", "₩"); }
 *
 * The remap is honoured by every other app on the system — browsers, native apps, and this app's
 * own text inputs — and ignored only inside the terminal, which delivers the raw layout character
 * to the PTY. The cause is the same one the rest of this suite is about: the substitution lives in
 * the text system's `insertText:` callback, so a terminal that produces its byte from the
 * **keydown** and then calls `preventDefault()` cancels the pipeline before the substitution can
 * arrive.
 *
 * Byte-wise this is the full-width-punctuation shape with a different producer — a keydown still
 * carrying the physical layout character, no composition session anywhere, and the real character
 * arriving only in the following `insertText` input event — so it is dispatched through the same
 * helper and pinned to the same macOS ownership policy.
 *
 * Two layout variants of the same physical key are covered, and the second is why this spec is not
 * redundant. Korean layouts disagree about what the backquote position produces: 두벌식 and
 * 세벌식 390 put ₩ there, 세벌식 최종 puts `*`. A character allowlist can only honour the remap for
 * the characters someone remembered to list, so it fixes the reported ₩ and silently drops the
 * identical remap for a 세벌식 최종 user. Deciding on the event's shape instead of on the character
 * covers both, which is what the variant arm pins.
 *
 * The paired control matters as much as the positive case. A "fix" that special-cased the layout
 * character into a backquote would satisfy the remap arm and be wrong for every Korean user who has
 * no remap, so the unremapped key is asserted to still deliver its own character — once in the
 * shape macOS produces with no remap at all (the keydown carries the glyph), and once through the
 * remap path with the substitution set to that character itself, which is the config's second line.
 */
import type { CDPSession } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { readTerminalImeBoundaryTrace } from './terminal-ime-boundary-probe'
import {
  dispatchImeRewrittenPrintableKey,
  dispatchImeSubstitutedTextKey,
  dispatchPlainEnter,
  type ImeKeyIdentity
} from './terminal-ime-cdp-composition'
import {
  createTerminalImeByteReader,
  removeTerminalImeByteReader,
  startTerminalImeByteReader,
  waitForTerminalImeBytes
} from './terminal-ime-byte-reader'
import { applyImePlatformPolicy, expectImePlatformPolicy } from './terminal-ime-platform-policy'

const BACKQUOTE = '`'

/** What the physical backquote position inserts, per Korean layout, before any remap. */
const LAYOUT_VARIANTS = [
  { label: '두벌식', character: '₩' },
  { label: '세벌식 최종', character: '*' }
] as const

type RemapArm = {
  name: string
  slug: string
  /** What the text system commits for the keystroke. */
  committed: (layoutCharacter: string) => string
  dispatch: (session: CDPSession, key: ImeKeyIdentity, committed: string) => Promise<void>
}

const REMAP_ARMS: readonly RemapArm[] = [
  {
    // The reported bug. The keydown carries the layout character and the backquote exists only in
    // the `insertText` event the remap produces, so anything that emits bytes from the keydown
    // sends the layout character and the user's system-wide remap is dropped at the terminal.
    name: 'a system remap rewrites it to a backquote',
    slug: 'remapped-to-backquote',
    committed: () => BACKQUOTE,
    dispatch: (session, key, committed) => dispatchImeSubstitutedTextKey(session, key, committed)
  },
  {
    // Control. With no remap the text system commits the layout character itself and macOS puts it
    // straight on the keydown. A rewrite that mapped the key to a backquote unconditionally fails
    // here.
    name: 'no remap is installed',
    slug: 'unremapped',
    committed: (layoutCharacter) => layoutCharacter,
    dispatch: (session, key) => dispatchImeRewrittenPrintableKey(session, key)
  },
  {
    // Control on the substitution path itself, which is the config's second line: the remap is
    // present and commits the layout character. Same `insertText` route as the first arm, opposite
    // expected byte, so a fix that keys on the route rather than on what was committed cannot pass
    // both.
    name: 'a system remap substitutes it for itself',
    slug: 'remapped-to-itself',
    committed: (layoutCharacter) => layoutCharacter,
    dispatch: (session, key, committed) => dispatchImeSubstitutedTextKey(session, key, committed)
  }
]

test.describe('Terminal macOS system key remap', () => {
  for (const layout of LAYOUT_VARIANTS) {
    // keyCode 192 is the backquote position itself, unchanged by which character the layout puts
    // on it — the remap targets the key, not the character.
    const layoutKey: ImeKeyIdentity = { key: layout.character, code: 'Backquote', keyCode: 192 }

    for (const arm of REMAP_ARMS) {
      const committed = arm.committed(layout.character)
      const forbidden = committed === BACKQUOTE ? layout.character : BACKQUOTE

      test(`sends ${committed} for the ${layout.label} backquote key when ${arm.name}`, async ({
        orcaPage,
        testRepoPath
      }, testInfo) => {
        await applyImePlatformPolicy(orcaPage, 'mac')
        await expectImePlatformPolicy(orcaPage, 'mac')
        const arena = await openTerminalImePaneArena(orcaPage)
        const reader = createTerminalImeByteReader(testRepoPath, 1)
        let completed = false
        try {
          await startTerminalImeByteReader(orcaPage, arena.ptyId, reader)
          await arm.dispatch(arena.session, layoutKey, committed)
          await orcaPage.waitForTimeout(60)
          await dispatchPlainEnter(arena.session)

          const trace = await readTerminalImeBoundaryTrace(orcaPage)

          // A remap is not an IME. Nothing here may open a composition session, and a spec that
          // accidentally replayed one would be testing a path the suite already covers.
          const compositionEvents = trace.dom
            .map((event) => event.type)
            .filter((type) => type.startsWith('composition'))
          expect(compositionEvents).toEqual([])
          // Pins the producer: the physical backquote position, carrying the layout's character.
          // What was committed is asserted on the wire below rather than on the DOM, because the
          // commit's `input` event is consumed before this probe sees it once a forwarder owns it.
          const keydowns = trace.dom.filter(
            (event) => event.type === 'keydown' && event.code === 'Backquote'
          )
          expect(keydowns).toHaveLength(1)
          expect(keydowns[0].key).toBe(layout.character)

          const sent = trace.onData.join('')
          expect(sent, `${forbidden} reached the PTY instead of ${committed}`).not.toContain(
            forbidden
          )
          expect(sent).toBe(`${committed}\r`)

          const received = await waitForTerminalImeBytes(orcaPage, reader)
          expect(received).toEqual([Buffer.from(`${committed}\n`).toString('hex')])
          completed = true
        } finally {
          await closeTerminalImePaneArena(
            arena,
            testInfo,
            `${arm.slug}-${layout.label}`,
            !completed
          )
          removeTerminalImeByteReader(reader)
        }
      })
    }
  }
})
