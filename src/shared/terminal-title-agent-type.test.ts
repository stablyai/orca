import { describe, expect, it } from 'vitest'
import { getAgentLabel as getSharedAgentLabel } from './agent-title-identity'
import {
  clearWorkingIndicators,
  detectAgentStatusFromTitle,
  normalizeTerminalTitle
} from './agent-title-status'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import {
  isClaudeAgent,
  isGrokRotatingWorkingTitle,
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('isGrokRotatingWorkingTitle', () => {
  it('matches Grok working frames regardless of the rotating middle text', () => {
    expect(isGrokRotatingWorkingTitle('⠋ - Waiting for response… - grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠴ - Thinking - grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠦ - Sleep 2s then echo hello… - grok')).toBe(true)
    // Collapsed/stable form must stay matched so re-normalization is idempotent.
    expect(isGrokRotatingWorkingTitle('⠋ grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠋ Grok')).toBe(true)
  })

  it('ignores non-working, non-Grok, and lookalike titles', () => {
    expect(isGrokRotatingWorkingTitle('grok')).toBe(false) // idle bare name, no spinner
    expect(isGrokRotatingWorkingTitle('Fix the auth bug - grok')).toBe(false) // session title, no spinner
    expect(isGrokRotatingWorkingTitle('⠋ debugging grok - claude')).toBe(false) // trailing name is another agent
    expect(isGrokRotatingWorkingTitle('⠋ ~/grok-scratch/ready')).toBe(false) // path fragment, not a trailing token
    expect(isGrokRotatingWorkingTitle('⠋ grokking the plan')).toBe(false) // "grok" not a whole trailing token
    expect(isGrokRotatingWorkingTitle('⠋ Codex')).toBe(false)
    // Task text ending in "grok" is not the Grok frame shape "spinner - phrase - grok".
    expect(isGrokRotatingWorkingTitle('⠋ wire up grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ Codex is thinking about grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ support for Grok')).toBe(false)
    // Why: Claude/Codex braille + task can end with " - grok" without the
    // post-spinner delimiter that marks a real Grok Build frame.
    expect(isGrokRotatingWorkingTitle('⠋ fix the flaky suite - grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ review grok integration - claude')).toBe(false)
  })
})

describe('resolveExplicitTerminalTitleAgentType', () => {
  it('maps explicit product-name titles to their TuiAgent id', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ Claude Code')).toBe('claude')
    expect(resolveExplicitTerminalTitleAgentType('⠋ Codex')).toBe('codex')
    expect(resolveExplicitTerminalTitleAgentType('✦ Gemini CLI')).toBe('gemini')
    expect(resolveExplicitTerminalTitleAgentType('MiMo Code')).toBe('mimo-code')
    expect(resolveExplicitTerminalTitleAgentType('⠋ OpenClaude')).toBe('openclaude')
    expect(resolveExplicitTerminalTitleAgentType('OMP')).toBe('omp')
  })

  it('treats Claude generic status prefixes as activity-only, not identity', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ investigating startup')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('⠸ investigating startup')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('. Compare Opencode Vs Orca')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('* Review Codex behavior')).toBeNull()
  })

  it('resolves OpenCode native abbreviated session titles before task-text identities', () => {
    expect(resolveExplicitTerminalTitleAgentType('OC | Understand about the plugin')).toBe(
      'opencode'
    )
    expect(resolveExplicitTerminalTitleAgentType('OC | Compare Codex and Claude')).toBe('opencode')
    // Why: Gemini glyphs inside OpenCode session text must not rebrand the tab.
    expect(resolveExplicitTerminalTitleAgentType('OC | ✦ Gemini CLI')).toBe('opencode')
    expect(getSharedAgentLabel('OC | Compare Codex and Claude')).toBe('OpenCode')
    expect(getSharedAgentLabel('OC | ✦ Gemini CLI')).toBe('OpenCode')
    expect(resolveExplicitTerminalTitleAgentType('tmux | OC | ses_123')).toBe('opencode')
    expect(resolveExplicitTerminalTitleAgentType('OC|compact-session')).toBe('opencode')
    expect(resolveExplicitTerminalTitleAgentType('oc | Understand about the plugin')).toBeNull()
  })

  it('does not find an OpenCode marker inside another agent task title', () => {
    expect(isOpenCodeNativeTitle('⠋ Fix foo | OC | bar')).toBe(false)
    expect(resolveExplicitTerminalTitleAgentType('⠋ Fix foo | OC | bar')).toBeNull()
  })

  // Why: adversarial coverage — native OC must not steal Claude/Codex/Cursor/
  // Gemini/Pi identity, and those agents must keep resolving when titled normally.
  it('keeps other agents classified correctly alongside OpenCode native titles', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ Claude Code')).toBe('claude')
    expect(resolveExplicitTerminalTitleAgentType('⠋ Codex')).toBe('codex')
    expect(resolveExplicitTerminalTitleAgentType('✦ Gemini CLI')).toBe('gemini')
    expect(resolveExplicitTerminalTitleAgentType('Cursor Agent')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('Pi ready')).toBe('pi')
    expect(resolveExplicitTerminalTitleAgentType('OpenCode ready')).toBe('opencode')
    expect(resolveTerminalTitleAgentType('OC | ⠋ implementing the feature')).toBe('opencode')
    expect(isClaudeAgent('OC | ⠋ implementing the feature')).toBe(false)
    expect(isClaudeAgent('OC | Understand about the plugin')).toBe(false)
  })

  it('still resolves Claude when the title explicitly names Claude', () => {
    expect(resolveExplicitTerminalTitleAgentType('. Claude Code compare Opencode')).toBe('claude')
  })

  it('returns null for plain shell and unknown titles', () => {
    expect(resolveExplicitTerminalTitleAgentType('Terminal 1')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('zsh')).toBeNull()
  })

  // Why: `cursor` is ordinary editor vocabulary, so a name token is not identity.
  // A Claude/Codex tab working on cursor code must not commit to Cursor identity.
  it('resolves Cursor by its identity titles, never a bare cursor token', () => {
    expect(resolveExplicitTerminalTitleAgentType('Cursor Agent')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('⠋ Cursor Agent')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('Cursor ready')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('Cursor - action required')).toBe('cursor')
    // A Claude tab whose task text mentions a text cursor is not Cursor identity.
    expect(
      resolveExplicitTerminalTitleAgentType('⠋ preserve cursor visibility across replays')
    ).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('~/cursor-rules')).toBeNull()
  })
})

describe('resolveTerminalTitleAgentType', () => {
  // Why: the activity facet keeps Claude's braille prefix as Claude — but only when
  // the "cursor" it mentions is task text, not Cursor's own identity title.
  it('labels cursor-mentioning agent tabs by their true agent, real Cursor as cursor', () => {
    expect(resolveTerminalTitleAgentType('⠋ Cursor Agent')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor Agent')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor ready')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor - action required')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('⠋ preserve cursor visibility across replays')).toBe(
      'claude'
    )
    expect(resolveTerminalTitleAgentType('⠋ Codex: fix cursor offsets')).toBe('codex')
  })
})

// Why: this module carries its own isClaudeAgent copy parallel to agent-title-identity.ts;
// both got the identical isCursorAgentTitle guard, so pin this copy directly to catch drift.
describe('isClaudeAgent', () => {
  it('excludes real Cursor identity titles, keeps cursor-mentioning Claude braille titles', () => {
    expect(isClaudeAgent('⠋ Cursor Agent')).toBe(false)
    expect(isClaudeAgent('Cursor ready')).toBe(false)
    expect(isClaudeAgent('⠋ preserve cursor visibility across replays')).toBe(true)
    expect(isClaudeAgent('⠋ OpenClaude')).toBe(false)
  })
})

describe('qodercli vs Gemini terminal titles', () => {
  // Fixtures below are qodercli's own expected titles, copied from its suite
  // (packages/cli/src/utils/windowTitle.test.ts). qodercli forked gemini-cli and kept Gemini's
  // ✦/◇ glyphs, so these are the regression guard for the collision.
  const QODERCLI_IDLE = '◇ Fix terminal titles | Ready'
  const QODERCLI_WORKING = '✦ Fix terminal titles | Working'
  const QODERCLI_CONFIRM = '▲ Fix terminal titles | Action Required'

  it('identifies qodercli titles as qodercli, not gemini', () => {
    expect(resolveExplicitTerminalTitleAgentType(QODERCLI_IDLE)).toBe('qodercli')
    expect(resolveExplicitTerminalTitleAgentType(QODERCLI_WORKING)).toBe('qodercli')
    expect(resolveExplicitTerminalTitleAgentType(QODERCLI_CONFIRM)).toBe('qodercli')
    expect(getSharedAgentLabel(QODERCLI_WORKING)).toBe('Qoder CLI')
  })

  // Why: the resolvers above read the STORED title, and normalizeTerminalTitle rewrites it on the
  // way to storage (terminal-output-side-effects.ts:167,265). Asserting only on raw titles passed
  // while the app still showed Gemini, so pin the normalized value too.
  it('survives normalizeTerminalTitle on the storage path', () => {
    expect(normalizeTerminalTitle(QODERCLI_WORKING)).toBe('\u2726 Qoder CLI')
    expect(normalizeTerminalTitle(QODERCLI_IDLE)).toBe('\u25c7 Qoder CLI')
    expect(normalizeTerminalTitle(QODERCLI_CONFIRM)).toBe('\u25b2 Qoder CLI')
    expect(normalizeTerminalTitle(QODERCLI_WORKING.padEnd(80, ' '))).toBe('\u2726 Qoder CLI')
    // Why: Gemini's own collapse must be untouched.
    expect(normalizeTerminalTitle('\u2726  Working\u2026 (repo)')).toBe('\u2726 Gemini CLI')
  })

  // Why: normalizeTerminalTitle runs on every title update, so its own output must re-identify as
  // qodercli — otherwise the second pass hands the collapsed label back to Gemini.
  it('re-identifies its own collapsed label (idempotent)', () => {
    for (const collapsed of ['\u2726 Qoder CLI', '\u25c7 Qoder CLI', '\u25b2 Qoder CLI']) {
      expect(resolveExplicitTerminalTitleAgentType(collapsed)).toBe('qodercli')
      expect(normalizeTerminalTitle(collapsed)).toBe(collapsed)
    }
  })

  // Why: ▲ is ordinary text (deploy output, charts, log markers), unlike the dingbats Gemini uses.
  // An unanchored includes() turned any title containing it into a spurious attention badge, which
  // feeds the sidebar attention count and the status-tracker transitions.
  it('only treats ▲ as permission when it is the leading status glyph', () => {
    expect(detectAgentStatusFromTitle('\u280b fix \u25b2 deploy timeout')).not.toBe('permission')
    expect(detectAgentStatusFromTitle('\u2733 chart shows \u25b2 12% growth')).not.toBe(
      'permission'
    )
    expect(detectAgentStatusFromTitle(QODERCLI_CONFIRM)).toBe('permission')
    expect(detectAgentStatusFromTitle('\u25b2 Qoder CLI')).toBe('permission')
  })

  // Why: clearWorkingIndicators strips ✦ from stale exit titles. Gemini's collapsed label survives
  // that through its name token; qodercli's must too, or the pane loses identity on exit.
  it('keeps qodercli identity after working indicators are cleared', () => {
    expect(clearWorkingIndicators('\u2726 Qoder CLI')).toBe('Qoder CLI')
    expect(resolveExplicitTerminalTitleAgentType(clearWorkingIndicators('\u2726 Qoder CLI'))).toBe(
      'qodercli'
    )
    expect(resolveExplicitTerminalTitleAgentType(clearWorkingIndicators('\u2726 Gemini CLI'))).toBe(
      'gemini'
    )
  })

  // Why: the collapsed matcher accepts a bare "Qoder CLI", so pin that it stays anchored to the
  // whole title and never claims a task title that merely mentions the product.
  it('does not claim titles that only mention Qoder CLI', () => {
    expect(resolveExplicitTerminalTitleAgentType('Qoder CLI')).toBe('qodercli')
    expect(resolveExplicitTerminalTitleAgentType('fix the Qoder CLI bug')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('\u2733 compare Qoder CLI and Codex')).toBeNull()
  })

  it('reports a status for every qodercli state', () => {
    expect(detectAgentStatusFromTitle(QODERCLI_WORKING)).toBe('working')
    expect(detectAgentStatusFromTitle(QODERCLI_IDLE)).toBe('idle')
    // Why: qodercli uses \u25b2 where Gemini uses \u270b; without an explicit case this returned null.
    expect(detectAgentStatusFromTitle(QODERCLI_CONFIRM)).toBe('permission')
  })

  it('identifies qodercli titles padded to their native 80-char width', () => {
    // Why: computeTerminalTitle pads with trailing spaces, so ` | status` is not at end-of-string.
    expect(resolveExplicitTerminalTitleAgentType(QODERCLI_WORKING.padEnd(80, ' '))).toBe('qodercli')
    expect(
      resolveExplicitTerminalTitleAgentType('Qoder CLI (Fix terminal titles)'.padEnd(80, ' '))
    ).toBe('qodercli')
    expect(resolveExplicitTerminalTitleAgentType('Qoder CLI CN (Fix terminal titles)')).toBe(
      'qodercli'
    )
  })

  it('identifies qodercli titles whose status vocabulary differs across versions', () => {
    // Why: qodercli 7bdec7d7a put an arbitrary thought subject where the status word goes, and
    // 4df4be61d reverted it. Matching structure (not vocabulary) must cover binaries from both.
    expect(resolveExplicitTerminalTitleAgentType('✦ Fix titles | Analyzing the parser')).toBe(
      'qodercli'
    )
    // Why: a pipe inside the session title must not push the status segment out of reach.
    expect(resolveExplicitTerminalTitleAgentType('✦ fix a | b | Working')).toBe('qodercli')
  })

  it('still identifies upstream Gemini titles as gemini', () => {
    // Why: upstream emits `<glyph>  <Status> (context)` — two spaces, parenthesized, no pipe.
    expect(resolveExplicitTerminalTitleAgentType('✦  Working… (repo)')).toBe('gemini')
    expect(resolveExplicitTerminalTitleAgentType('◇  Ready (repo)')).toBe('gemini')
    expect(resolveExplicitTerminalTitleAgentType('✋  Action Required (repo)')).toBe('gemini')
    expect(resolveExplicitTerminalTitleAgentType('✦ Gemini CLI')).toBe('gemini')
  })

  it('does not claim a Gemini title whose status text contains a pipe', () => {
    // Why: the ` | ` test alone would match this. The one-space lookahead is what rejects it —
    // upstream Gemini always emits two spaces after the glyph.
    expect(resolveExplicitTerminalTitleAgentType('✦  Running ls | grep foo (repo)')).toBe('gemini')
  })

  it('does not claim multiplexer- or OpenCode-wrapped titles', () => {
    expect(resolveExplicitTerminalTitleAgentType('tmux | ✦ Fix titles | Working')).not.toBe(
      'qodercli'
    )
    expect(resolveExplicitTerminalTitleAgentType('OC | ✦ Gemini CLI')).toBe('opencode')
  })
})
