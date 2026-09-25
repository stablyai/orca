/**
 * Rendered evidence that a composition tail keeps the colours its cells had.
 *
 * The row here is deliberately **not** a recognised composer placeholder. Orca's mask
 * (`.orca-ime-composer-placeholder .xterm-composition-remainder { visibility: hidden }`) only
 * claims a row whose text is one of three exact stock strings behind a bold prompt glyph, so a
 * coloured shell prompt with arbitrary dim output beside it is drawn by the overlay like any other
 * tail — and before the fix it was drawn in one flat colour, because the tail came from
 * `translateToString`, which returns characters and no attributes.
 *
 * The assertion is on resolved colour, not on a screenshot: a screenshot of this row is a picture
 * of the same `getComputedStyle` values and cannot be diffed without pinning the runner's theme and
 * font. Truecolour SGR is used for the prompt segments so the expected values are exact numbers
 * rather than whatever palette the active theme happens to carry.
 *
 * Composition is driven through CDP `Input.imeSetComposition`, so this runs in the normal headless
 * project with no native input source. The row is written straight to the emulator because the
 * defect is in what the overlay draws over the buffer, not in anything reaching the pty.
 */
import { expect, test } from './helpers/orca-app'
import { closeTerminalImePaneArena, openTerminalImePaneArena } from './terminal-ime-pane-arena'
import { setImeComposition } from './terminal-ime-cdp-composition'
import { writeToActiveTerminal } from './terminal-ime-midline-occlusion-probe'
import { samplePreeditOverlay } from './terminal-ime-preedit-overlay-probe'
import {
  samplePreeditTailPaint,
  type PreeditTailNode
} from './terminal-ime-preedit-tail-paint-probe'

/** A shell-style prompt: truecolour branch, truecolour counter, arbitrary dim output beside it. */
const PROMPT_ROW = [
  '\x1b[2J\x1b[H',
  '\x1b[38;2;80;200;120mmain\x1b[39m',
  ' ',
  '\x1b[38;2;230;170;40m+3\x1b[39m',
  ' ',
  '\x1b[2mbuilding\x1b[22m',
  '\r'
].join('')
const PROMPT_TEXT = 'main +3 building'

/** `rgb(r, g, b)` / `rgba(r, g, b, a)` as numbers, so alpha can be asserted on its own. */
function parseColor(css: string): { r: number; g: number; b: number; a: number } | null {
  const parts = css.match(/-?[\d.]+/g)
  if (!parts || parts.length < 3) {
    return null
  }
  return {
    r: Number(parts[0]),
    g: Number(parts[1]),
    b: Number(parts[2]),
    a: parts.length > 3 ? Number(parts[3]) : 1
  }
}

function nodeNamed(nodes: PreeditTailNode[], text: string): PreeditTailNode {
  const node = nodes.find((candidate) => candidate.text === text)
  if (!node) {
    throw new Error(
      `the tail emitted no run for ${JSON.stringify(text)} — got ${JSON.stringify(nodes)}`
    )
  }
  return node
}

test.describe('Terminal composition tail painting', () => {
  test('keeps a coloured prompt and dim output in their own colours behind a preedit', async ({
    orcaPage
  }, testInfo) => {
    const arena = await openTerminalImePaneArena(orcaPage)
    let completed = false
    try {
      await writeToActiveTerminal(orcaPage, PROMPT_ROW)
      await setImeComposition(arena.session, '아')

      // Blind to the tail on purpose: it holds identically with and without the fix, so the colour
      // assertions below are what discriminate.
      await expect
        .poll(
          async () => {
            const overlay = await samplePreeditOverlay(orcaPage)
            return overlay.active && overlay.rect.width > 0 && overlay.text.startsWith('아')
          },
          {
            message: 'the preedit never reached the overlay at a non-zero size'
          }
        )
        .toBe(true)
      const sample = await samplePreeditTailPaint(orcaPage)

      expect(sample.found, 'the overlay rendered no tail to assert about').toBe(true)
      expect(sample.rowTailFromCursor, 'the row under the cursor is not the prompt').toBe(
        PROMPT_TEXT
      )
      // The row this spec is pointed at must reach the screen. A stock placeholder would be masked
      // instead, which is what made the original before/after screenshots unusable as evidence.
      expect(
        sample.maskedVisibility,
        'the composer-placeholder mask claimed this row, so nothing here is about painting'
      ).toBe('visible')
      expect(sample.text, 'the tail does not reproduce the row it covers').toBe(PROMPT_TEXT)

      // Stated first so a regression reports the shape of the defect rather than a missing run:
      // before the fix the whole tail came back as one unstyled text node, whatever its cells had.
      expect(
        sample.nodes.filter((node) => node.styled).length,
        `the tail was drawn as one flat run: ${JSON.stringify(sample.nodes)}`
      ).toBe(3)

      const view = parseColor(sample.viewColor)
      expect(view, `the overlay has no resolved colour: ${sample.viewColor}`).not.toBe(null)

      // The two truecolour segments: exact numbers, independent of the active theme.
      const branch = parseColor(nodeNamed(sample.nodes, 'main').color)
      expect(branch, `the branch run is not painted: ${JSON.stringify(sample.nodes)}`).toEqual({
        r: 80,
        g: 200,
        b: 120,
        a: 1
      })
      const counter = parseColor(nodeNamed(sample.nodes, '+3').color)
      expect(counter, `the counter run is not painted: ${JSON.stringify(sample.nodes)}`).toEqual({
        r: 230,
        g: 170,
        b: 40,
        a: 1
      })

      // Dim has no colour of its own; it halves whatever the foreground is, which is the one thing
      // a flat-coloured tail can never show.
      const dim = parseColor(nodeNamed(sample.nodes, 'building').color)
      expect(dim?.a, `the dim run is not faded: ${JSON.stringify(sample.nodes)}`).toBeCloseTo(
        0.5,
        2
      )

      // The load-bearing comparison: before the fix every one of these was the overlay's own
      // colour, because the tail was a single unstyled text node.
      for (const node of sample.nodes.filter((candidate) => candidate.text.trim())) {
        expect(
          node.color,
          `the ${JSON.stringify(node.text)} run is still painted in the overlay's own colour`
        ).not.toBe(sample.viewColor)
        expect(node.styled, `the ${JSON.stringify(node.text)} run emitted no style`).toBe(true)
      }
      // The plain spaces between them still inherit, so the default case is unchanged.
      for (const node of sample.nodes.filter((candidate) => !candidate.text.trim())) {
        expect(node.styled, 'a default-styled gap took a style it did not need').toBe(false)
        expect(node.color, 'a default-styled gap stopped inheriting the overlay colour').toBe(
          sample.viewColor
        )
      }
      completed = true
    } finally {
      await closeTerminalImePaneArena(arena, testInfo, 'preedit-tail-paint', !completed)
    }
  })
})
