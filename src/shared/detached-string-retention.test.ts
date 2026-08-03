import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createAgentStatusOscProcessor } from './agent-status-osc'
import {
  AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH,
  normalizeAgentStatusPayload
} from './agent-status-types'
import {
  createCodexSubagentTranscriptState,
  reconcileCodexSubagentTranscript
} from './codex-subagent-transcript'
import { createCommandCodeOutputStatusDetector } from './command-code-output-status'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'
import { extractAllOscTitles } from './osc-title-extraction'
import { extractOscTitleScanTail } from './osc-title-scan-tail'
import { measureRetention, retentionCase, type RetentionCase } from './string-retention-measurement'
import { scanMode2031Sequences } from './terminal-color-scheme-protocol'
import { createTerminalGitHubPRLinkDetector } from './terminal-github-pr-link-detector'
import { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'
import { advancePartialEscapeTail } from './terminal-partial-escape-tail'
import { extractHiddenStartupRendererQueryData } from './terminal-reply-query-extraction'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from './terminal-reply-query-scan'

const MIB = 1024 * 1024
const PTY_CHUNK_CHARS = 16 * 1024
const PTYS = 512
const SPLIT_PRIVATE_MODE_TAIL = '\x1b[?1049;2004;2026;1234'
const SPLIT_QUERY_PREFIX = '\x1b[?1049;2004;2026'
const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const CODEX_PROMPT = '\x1b[1m›\x1b[0m Ask Codex to do anything'

// One shared sink, matching the single callback production installs per scanner.
const osc133Finished = vi.fn()

// One detector across all samples, so its seenUrls set accumulates like production's.
const seenUrlAccumulatingDetector = createTerminalGitHubPRLinkDetector()

const CODEX_CHILD_ID = '019fa65f-3144-7151-9c02-cff7a28f316f'
const codexStartedLine = JSON.stringify({
  type: 'event_msg',
  payload: {
    type: 'sub_agent_activity',
    occurred_at_ms: 1234,
    agent_thread_id: CODEX_CHILD_ID,
    agent_path: '/root/sidebar_repro',
    kind: 'started'
  }
})
const codexBulkLine = JSON.stringify({ type: 'event_msg', payload: { type: 'x'.repeat(500_000) } })
const codexDir = mkdtempSync(join(tmpdir(), 'codex-subagent-transcript-retention-'))

afterAll(() => {
  rmSync(codexDir, { recursive: true, force: true })
})

const RETENTION_CASES: RetentionCase[] = [
  // Production persists one title scan tail per PTY.
  retentionCase({
    name: 'osc title scan tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) =>
      `${'x'.repeat(PTY_CHUNK_CHARS)}\x1b]0;✳ Working… (esc to interrupt) pty-${index}`,
    retain: (source) => extractOscTitleScanTail(source),
    verify: (first) => {
      expect(first).toBe('\x1b]0;✳ Working… (esc to interrupt) pty-0')
    }
  }),

  // This guards 16 KiB chunk detachment, not a production OOM reproduction.
  retentionCase({
    name: 'osc title extracted from a pty chunk',
    sourceChars: PTY_CHUNK_CHARS,
    samples: 4096,
    maxRetainedMiB: 8,
    source: (index) =>
      `${'x'.repeat(PTY_CHUNK_CHARS)}\x1b]0;✳ Working… (esc to interrupt) ${index}\x07`,
    retain: (source) => extractAllOscTitles(source).at(-1) as string,
    verify: (first) => {
      expect(first).toBe('✳ Working… (esc to interrupt) 0')
    }
  }),

  // Production persists and snapshots one partial escape tail per emulator.
  retentionCase({
    name: 'partial escape tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}\x1b]0;pane-${index} title`,
    retain: (source) => advancePartialEscapeTail('', source),
    verify: (first) => {
      expect(first).toBe('\x1b]0;pane-0 title')
      expect(advancePartialEscapeTail(first, '\x07rest')).toBe('')
    }
  }),

  // The ≥13-char control arm proves detachment for one persisted tail per tracker.
  retentionCase({
    name: 'kitty scan tail from a live chunk',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}pty-${index}${SPLIT_PRIVATE_MODE_TAIL}`,
    retain: (source) => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.scan(source)
      return tracker
    },
    verify: (first) => {
      expect(SPLIT_PRIVATE_MODE_TAIL.length).toBeGreaterThanOrEqual(13)
      first.scan('9h')
      expect(first.isAlternateScreen).toBe(true)
    }
  }),

  // Replay consumes whole reattach snapshots rather than 16 KiB live chunks.
  retentionCase({
    name: 'kitty scan tail from a reattach snapshot',
    sourceChars: 5000 * 120,
    samples: 20,
    maxRetainedMiB: 2,
    source: (index) => `${'x'.repeat(5000 * 120)}pane-${index}${SPLIT_PRIVATE_MODE_TAIL}`,
    retain: (source) => {
      const tracker = new TerminalKittyKeyboardModeTracker()
      tracker.scanReplay(source)
      return tracker
    },
    verify: (first) => {
      first.scan('9h')
      expect(first.isAlternateScreen).toBe(true)
    }
  }),

  // Production persists one private-mode tail per pane.
  retentionCase({
    name: 'mode 2031 private-mode tail',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}pane-${index}\x1b[?1049;2004;2026;12345`,
    retain: (source) => scanMode2031Sequences('', source).tail,
    verify: (first) => {
      expect(first).toBe('\x1b[?1049;2004;2026;12345')
    }
  }),

  // Production persists one unterminated payload per pane.
  retentionCase({
    name: 'carried osc 9999 agent status payload',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) =>
      `${'x'.repeat(PTY_CHUNK_CHARS)}\x1b]9999;{"state":"working","prompt":"p-${index}"`,
    retain: (source) => {
      const processChunk = createAgentStatusOscProcessor()
      processChunk(source)
      return processChunk
    },
    verify: (first) => {
      expect(first('}\x07').payloads[0]).toEqual({ state: 'working', prompt: 'p-0' })
    }
  }),

  // Production persists one unterminated payload per pane scanner.
  retentionCase({
    name: 'osc 133 command-finished carry',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) =>
      `${'x'.repeat(PTY_CHUNK_CHARS)}\x1b]133;D;${index} pending payload tail text`,
    retain: (source) => {
      const scanner = createOsc133CommandFinishedScanner(osc133Finished)
      scanner.scan(source)
      return scanner
    },
    verify: (first) => {
      first.scan('\x07')
      expect(osc133Finished).toHaveBeenCalledWith(0)
    }
  }),

  // Production persists one URL carry per pane or PTY.
  retentionCase({
    name: 'github pr link carry',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}https://github.com/acme/repo-${index}/pul`,
    retain: (source) => {
      const observe = createTerminalGitHubPRLinkDetector()
      observe(source)
      return observe
    },
    verify: (first) => {
      expect(first('l/12\n')).toEqual([
        {
          url: 'https://github.com/acme/repo-0/pull/12',
          slug: { owner: 'acme', repo: 'repo-0', host: 'github.com' },
          number: 12
        }
      ])
    }
  }),

  // Unlike the carry, seenUrls only grows: one detector accumulates every URL it ever saw.
  retentionCase({
    name: 'github pr link seen-url set',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) =>
      `${'x'.repeat(PTY_CHUNK_CHARS)}https://github.com/acme/repo-${index}/pull/${index + 1}\n`,
    retain: (source) => seenUrlAccumulatingDetector(source),
    verify: (first) => {
      expect(first).toEqual([
        {
          url: 'https://github.com/acme/repo-0/pull/1',
          slug: { owner: 'acme', repo: 'repo-0', host: 'github.com' },
          number: 1
        }
      ])
    }
  }),

  // Production persists two 512-char rings per startup-draft waiter.
  retentionCase({
    name: 'draft paste scanner recent rings',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${DECSET_BRACKETED_PASTE}${'x'.repeat(PTY_CHUNK_CHARS)}pane-${index}`,
    retain: (source) => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      scanner.observe(source)
      return scanner
    },
    verify: (first) => {
      expect(first.observe(CODEX_PROMPT)).toEqual({ ready: true, armQuietTimer: false })
    }
  }),

  // The ≥13-char control arm proves detachment for one persisted query per pane.
  retentionCase({
    name: 'carried hidden startup renderer query',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}pane-${index}${SPLIT_QUERY_PREFIX}`,
    retain: (source) => extractHiddenStartupRendererQueryData(source, '').pending,
    verify: (first) => {
      expect(first).toBe(SPLIT_QUERY_PREFIX)
      expect(first.length).toBeGreaterThanOrEqual(13)
      expect(extractHiddenStartupRendererQueryData('$p', first).statefulQueryData).toBe(
        `${SPLIT_QUERY_PREFIX}$p`
      )
    }
  }),

  // The ≥13-char control arm proves detachment for one persisted mobile-stream query.
  retentionCase({
    name: 'reply query pending split query',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}pty-${index}${SPLIT_QUERY_PREFIX}`,
    retain: (source) =>
      scanTerminalReplyQuerySequences(source, 0, EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE).state,
    verify: (first) => {
      expect(SPLIT_QUERY_PREFIX.length).toBeGreaterThanOrEqual(13)
      const pendingStartSeq = first.pendingStartSeq!
      const resumed = scanTerminalReplyQuerySequences(
        '$p',
        pendingStartSeq + SPLIT_QUERY_PREFIX.length,
        first
      )
      expect(resumed.queries).toEqual([
        {
          data: `${SPLIT_QUERY_PREFIX}$p`,
          startSeq: pendingStartSeq,
          endSeq: pendingStartSeq + SPLIT_QUERY_PREFIX.length + 2
        }
      ])
    }
  }),

  // Every pane persists this ring before Command Code detection.
  retentionCase({
    name: 'command code recent raw-text ring',
    sourceChars: PTY_CHUNK_CHARS,
    samples: PTYS,
    source: (index) => `${'x'.repeat(PTY_CHUNK_CHARS)}pane-${index}`,
    retain: (source) => {
      const detector = createCommandCodeOutputStatusDetector({ onWorking: () => undefined })
      detector.observe(source)
      return detector
    },
    verify: (first) => {
      expect(first).toBeDefined()
    }
  }),

  // The store caches capped interactive prompts.
  retentionCase({
    name: 'capped interactive prompt',
    sourceChars: 2 * MIB,
    samples: 64,
    maxRetainedMiB: 16,
    source: (index) => `{"questions":["q-${index}"`.padEnd(2 * MIB, 'z'),
    retain: (source) =>
      normalizeAgentStatusPayload({ state: 'waiting', interactivePrompt: source }),
    verify: (first) => {
      expect(first!.interactivePrompt).toHaveLength(AGENT_STATUS_INTERACTIVE_PROMPT_MAX_LENGTH)
    }
  }),

  // Production persists one partial line per transcript cursor.
  retentionCase({
    name: 'codex transcript carried partial line',
    sourceChars: 500_000,
    samples: 128,
    maxRetainedMiB: 8,
    source: (index) => `${codexStartedLine}\n${codexBulkLine}\n{"partial":${index}`,
    prepare: (source, index) => {
      writeFileSync(join(codexDir, `rollout-parent-${index}.jsonl`), source)
    },
    retain: (_source, index) => {
      const state = createCodexSubagentTranscriptState()
      reconcileCodexSubagentTranscript(
        state,
        new Map(),
        join(codexDir, `rollout-parent-${index}.jsonl`)
      )
      return state
    },
    verify: (first) => {
      expect(first.parent.carry).toBe('{"partial":0')
    }
  })
]

describe('detached string retention', () => {
  it.each(RETENTION_CASES)('$name does not pin its source', (entry) => {
    const measured = measureRetention(entry)
    expect(measured.samples).toBe(entry.samples)
    entry.verify(measured.first as never)
    expect(
      measured.retainedMiB,
      `${entry.name}: retained ${measured.retainedMiB.toFixed(2)} MiB of a possible ${measured.pinnedMiB} MiB`
    ).toBeLessThan(measured.budgetMiB)
  })
})
