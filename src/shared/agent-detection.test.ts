import { describe, expect, it } from 'vitest'

import {
  detectAgentStatusFromTitle,
  extractAllOscTitles,
  extractLastOscTitle,
  getAgentLabel,
  isCursorAgentTitle,
  MAX_OSC_TITLE_CHARS,
  MAX_OSC_TITLES_PER_CHUNK,
  normalizeTerminalTitle
} from './agent-detection'
import {
  hasCompatibleAgentTitleIdentity,
  normalizeCompatibleAgentStatusEntryForOwner,
  normalizeCompatibleAgentTitleForOwner,
  resolveCompatibleAgentTypeForOwner
} from './agent-title-owner'
import { SYNTHETIC_AGENT_TITLE_PROFILES } from './synthetic-agent-title'

describe('OSC title extraction', () => {
  it('extracts the last OSC title from BEL-terminated PTY data', () => {
    expect(extractLastOscTitle('\x1b]0;First\x07noise\x1b]2;Second\x07')).toBe('Second')
  })

  it('extracts all OSC titles including ST-terminated titles', () => {
    expect(extractAllOscTitles('\x1b]0;First\x1b\\noise\x1b]2;Second\x07')).toEqual([
      'First',
      'Second'
    ])
  })

  it('ignores unterminated OSC titles', () => {
    expect(extractAllOscTitles('\x1b]0;Incomplete title')).toEqual([])
    expect(extractLastOscTitle('\x1b]0;Incomplete title')).toBeNull()
  })

  it('recovers when an abandoned incomplete OSC title is followed by a fresh title', () => {
    const data = '\x1b]0;abandoned\x1b]0;Fresh title\x07'

    expect(extractLastOscTitle(data)).toBe('Fresh title')
    expect(extractAllOscTitles(data)).toEqual(['Fresh title'])
  })

  it('extracts the final title after a large noisy PTY prefix', () => {
    const data = `${'pasted terminal noise \x1b]x;ignored\x07 '.repeat(10_000)}\x1b]0;Agent working\x07`

    expect(extractLastOscTitle(data)).toBe('Agent working')
    expect(extractAllOscTitles(data).at(-1)).toBe('Agent working')
  })

  it('caps oversized OSC titles before downstream title processing', () => {
    const title = `${'a'.repeat(MAX_OSC_TITLE_CHARS)}${'b'.repeat(10_000)}`
    const data = `before\x1b]0;${title}\x07after`

    const extracted = extractLastOscTitle(data)

    expect(extracted).toHaveLength(MAX_OSC_TITLE_CHARS)
    expect(extracted?.startsWith('a'.repeat(MAX_OSC_TITLE_CHARS / 2))).toBe(true)
    expect(extracted?.endsWith('b'.repeat(MAX_OSC_TITLE_CHARS / 2))).toBe(true)
    expect(extractAllOscTitles(data)).toEqual([extracted])
  })

  it('retains only the newest titles when one chunk contains limit +1', () => {
    const data = Array.from(
      { length: MAX_OSC_TITLES_PER_CHUNK + 1 },
      (_, index) => `\x1b]0;title-${index}\x07`
    ).join('')

    const titles = extractAllOscTitles(data)

    expect(titles).toHaveLength(MAX_OSC_TITLES_PER_CHUNK)
    expect(titles[0]).toBe('title-1')
    expect(titles.at(-1)).toBe(`title-${MAX_OSC_TITLES_PER_CHUNK}`)
  })
})

describe('MiMo title detection', () => {
  it.each([
    ['MiMo Code', 'idle'],
    ['mimo ready', 'idle'],
    ['mimo working', 'working'],
    ['\u280b MiMo Code', 'working']
  ] as const)('classifies %s', (title, expectedStatus) => {
    expect(getAgentLabel(title)).toBe('MiMo Code')
    expect(detectAgentStatusFromTitle(title)).toBe(expectedStatus)
  })

  it.each(['~/mimo/working', 'mimo-code-fixtures ready'])(
    'does not classify path or hyphen false positive %s',
    (title) => {
      expect(getAgentLabel(title)).toBeNull()
      expect(detectAgentStatusFromTitle(title)).toBeNull()
    }
  )
})

describe('permission keywords in agent titles', () => {
  it.each([
    ['Antigravity - fix permission bug', 'idle'],
    ['agy waiting for CI', 'idle'],
    ['codex permission-check', 'idle'],
    ['claude awaiting', 'idle'],
    ['agy | claude - action required', 'permission'],
    ['Codex - waiting for approval', 'permission']
  ])('classifies %j as %s', (title, status) => {
    expect(detectAgentStatusFromTitle(title)).toBe(status)
  })
})

describe('OpenCode native title detection', () => {
  // OC | names no agent token; native OpenCode titles need separate runtime corroboration.
  it.each(['OC | Implement the Kitty IME preview', 'tmux | OC | Implement the Kitty IME preview'])(
    'classifies the native session title %j as title-derived idle OpenCode',
    (title) => {
      expect(getAgentLabel(title)).toBe('OpenCode')
      expect(detectAgentStatusFromTitle(title)).toBe('idle')
    }
  )

  // Spinner detection precedes the OpenCode marker, so animated frames still mean working (#8940).
  it('reads a spinner-decorated native frame as working', () => {
    const title = 'OC | ⠋ ask claude about this'
    expect(getAgentLabel(title)).toBe('OpenCode')
    expect(detectAgentStatusFromTitle(title)).toBe('working')
  })

  it.each(['OC | ✦ Gemini CLI', 'OC | ✋ review Gemini permission handling'])(
    'does not let a Gemini glyph in OpenCode session text override identity for %j',
    (title) => {
      expect(getAgentLabel(title)).toBe('OpenCode')
      expect(detectAgentStatusFromTitle(title)).toBe('idle')
    }
  )

  // OpenCode summary text is subject matter, never keyword status; the marker alone asserts presence.
  it.each([
    'OC | ready to review',
    'OC | permission prompt keeps reappearing',
    'OC | waiting on the flaky test',
    'OC | stop the suite from running'
  ])('keeps the status word inside the session summary %j inert', (title) => {
    expect(getAgentLabel(title)).toBe('OpenCode')
    expect(detectAgentStatusFromTitle(title)).toBe('idle')
  })

  it.each(['OC |', 'OC|Build', 'oc | lowercase lookalike', 'OCTOPUS | build'])(
    'does not treat the lookalike title %j as an agent',
    (title) => {
      expect(detectAgentStatusFromTitle(title)).toBeNull()
    }
  )
})

describe('Pi-compatible title detection', () => {
  it.each([
    ['\u280b OMP', 'OMP', 'working'],
    ['OMP ready', 'OMP', 'idle'],
    ['OMP', 'OMP', 'idle'],
    ['OMP - action required', 'OMP', 'permission'],
    ['\u280b Pi', 'Pi', 'working'],
    ['Pi ready', 'Pi', 'idle'],
    // Old stored titles collapsed to Pi; re-detection must still classify idle.
    ['Pi', 'Pi', 'idle'],
    ['Pi - action required', 'Pi', 'permission']
  ] as const)('classifies synthesized %s', (title, expectedLabel, expectedStatus) => {
    expect(getAgentLabel(title)).toBe(expectedLabel)
    expect(detectAgentStatusFromTitle(title)).toBe(expectedStatus)
  })

  // OMP 17.2.12+ has static WSL/ConPTY state markers; later cwd/session glyphs must not override them (#13890).
  it.each([
    ['π : my-project', 'working', 'π : my-project'],
    ['π > my-project', 'idle', 'π > my-project'],
    ['π ! my-project', 'permission', 'π ! my-project'],
    ['π > gemini ✦ ⏲ ◇ ✋', 'idle', 'π > gemini ✦ ⏲ ◇ ✋'],
    ['zsh | π : my-project', 'working', 'zsh | π : my-project'],
    ['zsh | π > gemini ✦ ⏲ ◇ ✋', 'idle', 'zsh | π > gemini ✦ ⏲ ◇ ✋']
  ] as const)('classifies native OMP title %j as %s', (title, expectedStatus, expectedDisplay) => {
    expect(detectAgentStatusFromTitle(title)).toBe(expectedStatus)
    expect(normalizeTerminalTitle(title)).toBe(expectedDisplay)
  })

  it('re-detects status after display-title normalization for Pi idle frames', () => {
    // Normalization now preserves the session name and cwd (#16093).
    expect(normalizeTerminalTitle('π - my-project')).toBe('π - my-project')
    expect(detectAgentStatusFromTitle(normalizeTerminalTitle('π - my-project'))).toBe('idle')
    expect(detectAgentStatusFromTitle(normalizeTerminalTitle('\u280b π - my-project'))).toBe(
      'working'
    )
  })

  it.each([
    ['\u280b Pi', 'omp', '\u280b OMP'],
    ['Pi ready', 'omp', 'OMP ready'],
    ['Pi - action required', 'omp', 'OMP - action required'],
    // Replace the synthetic brand with launch ownership while preserving session/cwd (#16093).
    ['π - tmp', 'omp', 'OMP - tmp'],
    ['π: tmp', 'omp', 'OMP: tmp'],
    ['\u280b π: tmp', 'omp', '\u280b OMP: tmp'],
    ['\u280b π - tmp', 'omp', '\u280b OMP - tmp'],
    ['\u280b OMP', 'pi', '\u280b Pi'],
    [
      'lucky-echidna | \u283c π - Diagnose Orca terminal title flicker - test',
      'omp',
      'lucky-echidna | \u283c OMP - Diagnose Orca terminal title flicker - test'
    ],
    ['lucky-echidna | Pi ready', 'omp', 'OMP ready'],
    ['Codex | Pi ready', 'omp', 'OMP ready'],
    // The synthetic pane suffix must win even when the wrapper resembles a Claude braille title.
    ['lucky-echidna | ⠋ OMP', 'omp', '⠋ OMP'],
    [
      'lucky-echidna | \u283c π - Diagnose | test',
      'omp',
      'lucky-echidna | \u283c OMP - Diagnose | test'
    ]
  ] as const)('normalizes %s to the authoritative %s owner', (title, owner, expectedTitle) => {
    expect(normalizeCompatibleAgentTitleForOwner(title, owner)).toBe(expectedTitle)
  })

  it('preserves Pi-compatible custom titles and unrelated owners', () => {
    expect(normalizeCompatibleAgentTitleForOwner('Fix pi bugs', 'omp')).toBe('Fix pi bugs')
    // Preserve wrapped titles lacking a re-ownable identity in any segment.
    expect(normalizeCompatibleAgentTitleForOwner('lucky-echidna | Fix pi bugs', 'omp')).toBe(
      'lucky-echidna | Fix pi bugs'
    )
    expect(normalizeCompatibleAgentTitleForOwner('xxPi ready', 'omp')).toBe('xxPi ready')
    expect(normalizeCompatibleAgentTitleForOwner('\u280b Pi', 'codex')).toBe('\u280b Pi')
  })

  it('identifies titles whose compatible identity can be re-owned', () => {
    expect(hasCompatibleAgentTitleIdentity('Pi ready')).toBe(true)
    expect(hasCompatibleAgentTitleIdentity('π - tmp')).toBe(true)
    expect(hasCompatibleAgentTitleIdentity('\u280b OMP')).toBe(true)
    expect(hasCompatibleAgentTitleIdentity('Fix pi bugs')).toBe(false)
    expect(hasCompatibleAgentTitleIdentity('\u280b Codex')).toBe(false)
  })

  it('normalizes Pi-compatible status identity and terminal title to the owner', () => {
    const status = normalizeCompatibleAgentStatusEntryForOwner(
      {
        state: 'working',
        prompt: '',
        updatedAt: 1,
        stateStartedAt: 1,
        agentType: 'pi',
        paneKey: 'tab-1:leaf-1',
        terminalTitle: '\u280b Pi',
        stateHistory: []
      },
      'omp'
    )

    expect(status.agentType).toBe('omp')
    expect(status.terminalTitle).toBe('\u280b OMP')
    expect(resolveCompatibleAgentTypeForOwner('codex', 'omp')).toBe('codex')
  })

  it.each(['~/omp/working', 'omp-harness ready', '~/pi/working', 'pi-scratch ready'])(
    'does not classify path or hyphen false positive %s',
    (title) => {
      expect(getAgentLabel(title)).toBeNull()
      expect(detectAgentStatusFromTitle(title)).toBeNull()
    }
  )
})

describe('Cursor agent title identity', () => {
  // Pin every synthesized Cursor label so renaming cannot lose recipients or auto-Enter suppression.
  it('accepts every label Orca synthesizes for Cursor', () => {
    const profile = SYNTHETIC_AGENT_TITLE_PROFILES.cursor

    for (const label of [
      profile.workingLabel,
      `⠋ ${profile.workingLabel}`,
      profile.idleLabel,
      profile.permissionLabel
    ]) {
      expect(isCursorAgentTitle(label)).toBe(true)
    }
  })

  it.each([
    'Cursor Agent',
    '  cursor agent  ',
    '⠋ Cursor Agent',
    '⣿ Cursor Agent',
    'Cursor ready',
    'Cursor - action required'
  ])('accepts the native or Orca-synthesized Cursor title %j', (title) => {
    expect(isCursorAgentTitle(title)).toBe(true)
  })

  // Cursor in another agent's task summary is editor vocabulary, not process identity.
  it.each([
    '⠋ fix the text cursor blink',
    '✳ Fix the text cursor blink',
    '. fix cursor position',
    '* cursor rendering done',
    'Terminal Cursor and Orca slows down',
    'cursor-agent',
    'cursor.exe',
    '~/cursor-rules',
    '',
    null,
    undefined
  ])('rejects the non-Cursor title %j', (title) => {
    expect(isCursorAgentTitle(title)).toBe(false)
  })
})
