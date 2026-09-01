/**
 * OMP/Pi terminal titles: preserve the session label, collapse only the animation.
 *
 * The reported symptom was an OMP tab title flickering between "OMP" and "Pi" ~12x/sec.
 * OMP emits NEITHER string. Verified against oh-my-pi
 * (packages/coding-agent/src/utils/title-generator.ts): `DEFAULT_TERMINAL_TITLE = "π"` (:25)
 * and `buildTerminalTitleWithState` (:530-544) compose `π ⠋ <label>` / `π > <label>` /
 * `π ! <label>` — always the π glyph. On an Orca-hosted pane OMP's native titler cedes
 * entirely to Orca's OWN injected extension (src/main/pi/titlebar-extension-source.ts:21,44),
 * which writes `π - <session> - <cwd>` and `⠋ π - <session> - <cwd>` every 80ms.
 *
 * Both flapping strings were manufactured by Orca:
 *   "OMP" — `driveSyntheticTitleFromHook` (src/main/index.ts), from the omp profile's label.
 *   "Pi"  — `normalizeTerminalTitle` collapsing our own extension's output to a hardcoded
 *           literal, discarding the session name and cwd along with it (#16093).
 *
 * The fix removes both: the agent owns the title it animates (`synthesizeWorkingTitle: false`
 * — not the stronger `synthesizeTerminalTitle: false`, because terminal-state frames still
 * carry the pane's agent identity downstream), and the normalizer canonicalizes only the
 * rotating braille frame so consecutive frames dedupe while the label survives.
 */
import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle, normalizeTerminalTitle } from './agent-title-status'
import { isDecorativeAgentTitleFrameChange } from './agent-decorative-title-signature'
import {
  getSyntheticAgentTerminalTitle,
  shouldDriveSyntheticAgentTitleFromHook
} from './synthetic-agent-title'
import { normalizeCompatibleAgentTitleForOwner } from './agent-title-owner'
import { getPiCompatibleTitleSeparatorStatus } from './pi-compatible-synthetic-title'

// Verbatim from src/main/pi/titlebar-extension-source.ts:44 and oh-my-pi:530-544.
const ORCA_EXTENSION_WORKING = (frame: string): string => `${frame} π - fixing the sidebar - orca`
const OMP_NATIVE_WORKING = (frame: string): string => `π ${frame} fixing the sidebar`
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

describe('normalizeTerminalTitle keeps the OMP/Pi session label', () => {
  it.each([
    ['Orca extension (spinner leads)', ORCA_EXTENSION_WORKING],
    ['OMP native (spinner is medial)', OMP_NATIVE_WORKING]
  ])('collapses every %s frame to one value without losing the label', (_name, build) => {
    const normalized = new Set(FRAMES.map((frame) => normalizeTerminalTitle(build(frame))))

    expect(normalized.size).toBe(1)
    const [only] = [...normalized]
    expect(only).toContain('fixing the sidebar')
    expect(only).toContain('π')
    // The bare labels the old collapse minted must be gone entirely.
    expect(only).not.toBe('⠋ Pi')
    expect(only).not.toBe('Pi')
  })

  it('leaves idle and attention titles byte-identical', () => {
    for (const title of [
      'π - fixing the sidebar - orca',
      'π > fixing the sidebar',
      'π ! fixing the sidebar',
      'π: fixing the sidebar'
    ]) {
      expect(normalizeTerminalTitle(title)).toBe(title)
    }
  })

  // Why: a multiplexer prefixes the pane's title, so an anchored match skipped the collapse
  // and the frame churned straight through (#8032).
  it('collapses frames under a multiplexer prefix', () => {
    const normalized = new Set(
      FRAMES.map((frame) => normalizeTerminalTitle(`zsh | ${ORCA_EXTENSION_WORKING(frame)}`))
    )

    expect(normalized.size).toBe(1)
    expect([...normalized][0]).toContain('fixing the sidebar')
  })

  it('keeps two different sessions distinguishable', () => {
    expect(normalizeTerminalTitle('π - session A - orca')).not.toBe(
      normalizeTerminalTitle('π - session B - orca')
    )
  })
})

describe('detectAgentStatusFromTitle reads the π state separator', () => {
  it.each([
    ['π ! fixing the sidebar', 'permission'],
    ['π > fixing the sidebar', 'idle'],
    ['π ⠋ fixing the sidebar', 'working'],
    ['⠋ π - fixing the sidebar - orca', 'working'],
    ['π: fixing the sidebar', 'idle']
  ])('classifies %s as %s', (title, expected) => {
    expect(detectAgentStatusFromTitle(title)).toBe(expected)
  })
})

describe('the churn is gone at the suppressor', () => {
  it('treats consecutive animation frames as decoration', () => {
    for (const build of [ORCA_EXTENSION_WORKING, OMP_NATIVE_WORKING]) {
      for (let index = 1; index < FRAMES.length; index += 1) {
        expect(
          isDecorativeAgentTitleFrameChange(
            normalizeTerminalTitle(build(FRAMES[index - 1])),
            normalizeTerminalTitle(build(FRAMES[index]))
          )
        ).toBe(true)
      }
    }
  })

  it('still commits a real working -> attention transition', () => {
    expect(
      isDecorativeAgentTitleFrameChange(
        normalizeTerminalTitle(ORCA_EXTENSION_WORKING('⠋')),
        normalizeTerminalTitle('π ! fixing the sidebar')
      )
    ).toBe(false)
  })
})

describe('Orca stops writing over the working title it does not own', () => {
  // Why: the agent animates its own working title, so synthesizing there both replaced the
  // session label and fought its frames at 80ms — that pair is the flap.
  it.each(['omp', 'pi'] as const)('synthesizes no working title for %s', (agent) => {
    expect(shouldDriveSyntheticAgentTitleFromHook(agent, 'working')).toBe(false)
  })

  // Why NOT terminal states: the synthetic frame is also how the pane's agent identity reaches
  // downstream consumers, and both agents are quiet at rest so nothing churns.
  it.each(['omp', 'pi'] as const)('still synthesizes terminal states for %s', (agent) => {
    for (const state of ['done', 'waiting', 'blocked'] as const) {
      expect(getSyntheticAgentTerminalTitle(agent, state)).not.toBeNull()
      expect(shouldDriveSyntheticAgentTitleFromHook(agent, state)).toBe(true)
    }
  })

  it('leaves agents that own no title alone', () => {
    expect(getSyntheticAgentTerminalTitle('droid', 'done')).toBe('Droid ready')
    expect(shouldDriveSyntheticAgentTitleFromHook('droid', 'working')).toBe(true)
  })
})

describe('the owner relabel keeps the label and swaps only the brand', () => {
  // Why: this runs on the pane display title, tab title, sidebar rows and the mobile publish.
  // Collapsing a semantic title to a bare profile label re-destroyed the session name at display
  // time (#16093); keeping the brand as π would lose the explicit owner identity that #6689,
  // #7633 and #9077 established. Swapping the brand in place satisfies both.
  it.each([
    ['⠋ π - fixing the sidebar - orca', '⠋ OMP - fixing the sidebar - orca'],
    ['π - fixing the sidebar - orca', 'OMP - fixing the sidebar - orca'],
    ['π ! fixing the sidebar', 'OMP ! fixing the sidebar'],
    ['π > fixing the sidebar', 'OMP > fixing the sidebar']
  ])('rewrites %s to %s for an omp-owned pane', (title, expected) => {
    expect(normalizeCompatibleAgentTitleForOwner(title, 'omp')).toBe(expected)
  })

  // Why: the owner rewrite feeds status classification downstream, so a rewritten title must
  // classify exactly as its source did — that round-trip is why the old collapse existed.
  it.each([
    '⠋ π - fixing the sidebar - orca',
    'π - fixing the sidebar - orca',
    'π ! fixing the sidebar',
    'π > fixing the sidebar',
    '⠋ Pi',
    'Pi ready',
    'Pi - action required'
  ])('preserves the status of %s across the owner rewrite', (title) => {
    expect(detectAgentStatusFromTitle(normalizeCompatibleAgentTitleForOwner(title, 'omp'))).toBe(
      detectAgentStatusFromTitle(title)
    )
  })

  // Why keep: a bare frame carries no session text, and persisted pre-upgrade values are bare.
  // Re-owning them is what pins an OMP pane to OMP (#6689, #7633, #9077).
  it('still re-owns bare identity frames', () => {
    expect(normalizeCompatibleAgentTitleForOwner('⠋ Pi', 'omp')).toBe('⠋ OMP')
    expect(normalizeCompatibleAgentTitleForOwner('Pi ready', 'omp')).toBe('OMP ready')
    expect(normalizeCompatibleAgentTitleForOwner('⠋ OMP', 'pi')).toBe('⠋ Pi')
  })
})

describe('the state separator does not fire on ordinary titles', () => {
  // Why: the separator check runs on every title, so a project named `omp-harness` or a task
  // description starting "pi - …" must not read as an agent state. The owner rewrite only ever
  // emits the exact profile casing, so lowercase prose is safe to reject.
  it.each([
    'omp-harness ready',
    'pi-scratch ready',
    'pipeline - build',
    'pip - install',
    'pi - refactor the parser',
    'omp - deploy notes',
    'npm - run build',
    'node - server'
  ])('classifies %s as no agent', (title) => {
    expect(detectAgentStatusFromTitle(title)).toBeNull()
  })
})

describe('one real OMP turn', () => {
  // Why: the reported symptom was ~12 committed store patches per second on a working OMP tab.
  // This drives a full turn of the frames Orca's injected extension actually emits and counts
  // what survives the churn gate. Before the fix each frame alternated "⠋ Pi"/"⠋ OMP" and every
  // one of them committed.
  it('commits twice across 30 working frames plus the idle transition', () => {
    const frames = Array.from(
      { length: 30 },
      (_, index) => `${FRAMES[index % FRAMES.length]} π - fixing the sidebar - orca`
    )
    frames.push('π - fixing the sidebar - orca')

    const committed: string[] = []
    let previous: string | null = null
    for (const frame of frames) {
      const normalized = normalizeTerminalTitle(frame)
      if (previous !== null && isDecorativeAgentTitleFrameChange(previous, normalized)) {
        continue
      }
      if (normalized === previous) {
        continue
      }
      committed.push(normalized)
      previous = normalized
    }

    expect(committed).toEqual(['⠋ π - fixing the sidebar - orca', 'π - fixing the sidebar - orca'])
  })
})

describe('latent hazards the reviewers flagged', () => {
  // Why: `-` is both a state separator and the permission label's delimiter. This resolves
  // correctly today only because the synthetic check runs first in detectAgentStatusFromTitle,
  // and the separator fn is exported — so pin both the caller and the fn itself.
  it.each(['Pi - action required', 'OMP - action required'])(
    'classifies %s as permission, not idle',
    (title) => {
      expect(detectAgentStatusFromTitle(title)).toBe('permission')
      expect(getPiCompatibleTitleSeparatorStatus(title)).toBe('permission')
    }
  )

  // Why: the owner rewrite re-runs on its own output during hydration and seeding. It is a fixed
  // point only because getAgentLabel does not tokenize `omp`/`pi`; if that ever changes, a
  // rewritten title would collapse back to a bare label and lose the session text again.
  it.each([
    '⠋ π - fixing the sidebar - orca',
    'π - fixing the sidebar - orca',
    'π ! fixing the sidebar',
    'π ⠙ fixing the sidebar',
    'zsh | ⠙ π - a - b'
  ])('is a fixed point when the owner rewrite re-runs on %s', (title) => {
    const once = normalizeCompatibleAgentTitleForOwner(title, 'omp')
    expect(normalizeCompatibleAgentTitleForOwner(once, 'omp')).toBe(once)
    expect(once).toContain('OMP')
  })
})
