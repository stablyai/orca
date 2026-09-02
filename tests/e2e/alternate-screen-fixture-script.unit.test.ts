import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HOLD_ALTERNATE_SCREEN_OPEN,
  alternateScreenFixtureScript
} from './alternate-screen-fixture-script'
import {
  type HiddenPressureOutputMode,
  pressureOutputScript
} from './artificial-opencode-hidden-pressure-script'

// The escape as it appears in generated source, where it is still a JS string escape.
const ALTERNATE_SCREEN_ENTER_SOURCE = '\\x1b[?1049h'

const PRESSURE_MODES: HiddenPressureOutputMode[] = ['tui', 'plain', 'title', 'latin', 'rich-model']

describe('alternateScreenFixtureScript', () => {
  it('holds the painting process open so the alternate screen survives the assertions', () => {
    const source = alternateScreenFixtureScript('\x1b[?1049hFRAME')

    expect(source).toContain(HOLD_ALTERNATE_SCREEN_OPEN)
    expect(source).toContain('process.stdout.write("\\u001b[?1049hFRAME")')
    expect(source).not.toContain('setTimeout')
  })

  it('defers the paint by the requested delay and still holds open', () => {
    const source = alternateScreenFixtureScript('FRAME', 750)

    expect(source).toContain('setTimeout(() => process.stdout.write("FRAME"), 750)')
    expect(source).toContain(HOLD_ALTERNATE_SCREEN_OPEN)
  })
})

describe('hidden pressure fixture', () => {
  // Ratchet: entering the alternate screen and exiting is the dead-TUI shape the
  // recovery barrier deliberately dismisses, which silently emptied these panes.
  it.each(PRESSURE_MODES)(
    'keeps mode %s alive exactly when it enters the alternate screen',
    (mode) => {
      const source = pressureOutputScript('run-id', mode)

      expect(source.includes(HOLD_ALTERNATE_SCREEN_OPEN)).toBe(
        source.includes(ALTERNATE_SCREEN_ENTER_SOURCE)
      )
    }
  )

  it('holds the rich-model alternate screen open past its done marker', () => {
    const source = pressureOutputScript('run-id', 'rich-model')

    expect(source).toContain(ALTERNATE_SCREEN_ENTER_SOURCE)
    expect(source.indexOf(HOLD_ALTERNATE_SCREEN_OPEN)).toBeGreaterThan(
      source.indexOf('OPENCODE_PRESSURE_DONE_')
    )
  })
})

// Ratchet: the builder is only worth anything while the specs still route through it,
// and a fixture hand-rolled back to paint-and-exit would surface days later in a
// scheduled Electron run — the detection channel that produced this ticket.
describe('spec alternate-screen fixtures', () => {
  const SPEC_FIXTURE_BUILDERS: [spec: string, builder: string][] = [
    ['terminal-hidden-view-parking.spec.ts', 'writeParkedFrameScript'],
    ['terminal-hidden-view-parking.spec.ts', 'writeCycleReferenceScript'],
    ['terminal-hidden-tui-visual-restore.spec.ts', 'writeHiddenFrameScript']
  ]

  function readSpec(spec: string): string {
    return readFileSync(new URL(spec, import.meta.url), 'utf8')
  }

  function topLevelFunctionBody(source: string, name: string): string {
    const start = source.indexOf(`function ${name}(`)
    expect(start, `${name} was renamed or removed; re-point this ratchet`).toBeGreaterThan(-1)
    // Why '\n}' and a bound: '\n}\n' misses CRLF checkouts, and an unresolved indexOf slices to EOF,
    // letting a later builder call in the same file satisfy the assertion vacuously.
    const end = source.indexOf('\n}', start)
    expect(end, `${name} has no closing brace; re-point this ratchet`).toBeGreaterThan(start)
    return source.slice(start, end)
  }

  it.each(SPEC_FIXTURE_BUILDERS)('%s writes %s through the shared builder', (spec, builder) => {
    expect(topLevelFunctionBody(readSpec(spec), builder)).toContain('alternateScreenFixtureScript(')
  })

  it('the OSC 8 spec stages its link fixture through the shared builder', () => {
    expect(readSpec('terminal-osc8-cold-park-restore.spec.ts')).toContain(
      'stageNodeScriptForTerminal(alternateScreenFixtureScript('
    )
  })
})
