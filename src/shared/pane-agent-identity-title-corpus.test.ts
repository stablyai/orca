import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { collectAgentTitleEvidence } from './agent-title-evidence'
import { resolveCanonicalPaneAgentIdentity } from './pane-agent-identity-adapter'
import type { TuiAgent } from './tui-agent'

/**
 * Title regression gates for the identity-ladder migration.
 *
 * Two layers: a controlled fixture table that always runs (CI-safe), and a local characterization
 * gate over the machine's real recorded corpus. The corpus gate is not a CI prerequisite tied to
 * one developer's home — when no history exists it reports `corpus unavailable — skipped`
 * explicitly, never a silently green zero-title run. Raw titles never reach logs or failure
 * output; changed titles are reported as salted hashes plus old/new agent summaries only.
 */

const RECORDED_HISTORY_DIR = 'terminal-history'
const QUARANTINE_DIR = '.recovery-quarantine'

function orcaAppSupportCandidates(): string[] {
  if (process.platform === 'darwin') {
    return [join(homedir(), 'Library', 'Application Support', 'Orca')]
  }
  if (process.platform === 'win32') {
    return [join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Orca')]
  }
  return [
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Orca'),
    join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'Orca')
  ]
}

/** Deliberately shallow: `terminal-history/<session>/checkpoint.json` only, with the hidden
 *  quarantine subtree excluded BY NAME so a future recursive rewrite cannot silently turn
 *  quarantined recovery data into product regressions. */
function loadRecordedTitleCorpus(): { checkpointCount: number; titles: string[] } | null {
  const root = orcaAppSupportCandidates()
    .map((candidate) => join(candidate, RECORDED_HISTORY_DIR))
    .find((candidate) => existsSync(candidate))
  if (!root) {
    return null
  }
  let checkpointCount = 0
  const titles = new Set<string>()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === QUARANTINE_DIR || entry.name.startsWith('.')) {
      continue
    }
    const checkpointPath = join(root, entry.name, 'checkpoint.json')
    if (!existsSync(checkpointPath)) {
      continue
    }
    const parsed: unknown = JSON.parse(readFileSync(checkpointPath, 'utf8'))
    checkpointCount += 1
    const lastTitle = (parsed as { lastTitle?: unknown }).lastTitle
    if (typeof lastTitle === 'string' && lastTitle.length > 0) {
      titles.add(lastTitle)
    }
  }
  return { checkpointCount, titles: [...titles] }
}

/** What the canonical adapter answers when a title is all a pane has (the uncovered lane). */
function canonicalTitleOnlyAgent(title: string): TuiAgent | null {
  return resolveCanonicalPaneAgentIdentity({ title }).agent
}

describe('controlled title fixtures (always run)', () => {
  const FIXTURES: readonly { name: string; title: string; expected: TuiAgent | null }[] = [
    {
      name: 'mandatory adversarial owner suffix beats the agent names in task text',
      title: 'STA-4011 Linux Antigravity Commit Messages - grok',
      expected: 'grok'
    },
    {
      name: 'task text mentioning other agents is not identity',
      title: 'Compare Antigravity with Gemini 3.7 Flash',
      expected: null
    },
    {
      name: 'owner suffix still answers over mentioned agents',
      title: 'Compare Antigravity with Gemini 3.7 Flash… - grok',
      expected: 'grok'
    },
    { name: 'Claude status sigil is a vendor marker', title: '✳', expected: 'claude' },
    { name: 'Claude management screen is not identity', title: 'claude agents', expected: null },
    { name: 'a shell title names no agent', title: 'zsh', expected: null },
    { name: 'a default worktree-ish title names no agent', title: 'my-claude-fix', expected: null },
    {
      name: 'conflicting vendor markers resolve to nothing',
      title: '✳ | ✦ two sigils',
      expected: null
    },
    {
      name: 'conflicting anchored names resolve to nothing',
      title: 'OC | something… - grok',
      expected: null
    },
    { name: 'a bare Pi title anchors as Pi', title: 'pi', expected: 'pi' },
    { name: 'an OMP status title anchors as OMP', title: 'omp ready', expected: 'omp' },
    {
      // Wrapper-frame π/OMP separators are handled by the synthetic-title path, not this
      // evidence parser; pinned so a parser change here is a deliberate decision.
      name: 'a π wrapper frame is declined by the evidence parser',
      title: 'π : ready',
      expected: null
    }
  ]

  for (const fixture of FIXTURES) {
    it(fixture.name, () => {
      expect(collectAgentTitleEvidence(fixture.title).agent).toBe(fixture.expected)
      // The adapter's title-only lane must give the very same answer — phase 1 changes no
      // parser semantics, only provenance.
      expect(canonicalTitleOnlyAgent(fixture.title)).toBe(fixture.expected)
    })
  }
})

describe('recorded title corpus characterization (local gate)', () => {
  it('the canonical title-only lane matches the shipped parser on every recorded title', (ctx) => {
    const corpus = loadRecordedTitleCorpus()
    if (corpus === null) {
      console.info('corpus unavailable — skipped (no recorded terminal history on this machine)')
      ctx.skip()
      return
    }
    // A machine WITH history must never pass on an empty read — that would be a silently green
    // zero-title run, not a characterization.
    expect(corpus.checkpointCount).toBeGreaterThan(0)
    expect(corpus.titles.length).toBeGreaterThan(0)
    console.info(
      `corpus: ${corpus.checkpointCount} checkpoints, ${corpus.titles.length} distinct titles`
    )

    const salt = randomBytes(16).toString('hex')
    const changed: { titleHash: string; oldAgent: string | null; newAgent: string | null }[] = []
    for (const title of corpus.titles) {
      const oldAgent = collectAgentTitleEvidence(title).agent
      const newAgent = canonicalTitleOnlyAgent(title)
      if (oldAgent !== newAgent) {
        changed.push({
          titleHash: createHash('sha256').update(`${salt}:${title}`).digest('hex').slice(0, 16),
          oldAgent,
          newAgent
        })
      }
    }
    // Report hashes and agent summaries only; a reviewer who needs the raw value inspects the
    // protected corpus on the machine that owns it.
    expect(changed).toEqual([])
  }, 60_000)
})
