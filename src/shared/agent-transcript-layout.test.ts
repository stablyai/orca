import { describe, expect, it } from 'vitest'
import { codexRolloutThreadMatch, transcriptLayoutAgent } from './agent-transcript-layout'

const ID = 'b8dd2df2-0b3f-4dc0-ba10-9d8a4ac4f1a9'
const ROLLOUT = `rollout-2026-09-30T00-00-00-${ID}.jsonl`
const ENCODED_CWD = '-Users-example-repo'
const PROFILE = '3f6c2a1e-8d4b-4c7a-9e2f-1a2b3c4d5e6f'

describe('transcriptLayoutAgent', () => {
  it.each([
    [
      'macOS managed Codex home',
      `/Users/example/codex-runtime-home/home/sessions/2026/09/30/${ROLLOUT}`
    ],
    ['Linux / SSH remote', `/home/example/.codex/sessions/2026/09/30/${ROLLOUT}`],
    ['Windows drive path', `C:\\Users\\example\\.codex\\sessions\\2026\\09\\30\\${ROLLOUT}`],
    ['WSL UNC path', `\\\\wsl$\\Ubuntu\\home\\example\\.codex\\sessions\\2026\\09\\30\\${ROLLOUT}`],
    [
      'WSL localhost UNC path',
      `\\\\wsl.localhost\\Ubuntu\\home\\example\\.codex\\sessions\\2026\\09\\30\\${ROLLOUT}`
    ],
    ['mixed separators', `C:/Users/example\\.codex/sessions\\2026/09/30/${ROLLOUT}`]
  ])('reads a Codex rollout on %s', (_name, transcriptPath) => {
    expect(transcriptLayoutAgent({ id: ID, transcriptPath })).toBe('codex')
  })

  it.each([
    ['macOS', `/Users/example/.claude/projects/${ENCODED_CWD}/${ID}.jsonl`],
    ['Linux / SSH remote / WSL guest', `/home/example/.claude/projects/${ENCODED_CWD}/${ID}.jsonl`],
    ['Windows drive path', `C:\\Users\\example\\.claude\\projects\\C--repo\\${ID}.jsonl`],
    ['WSL UNC path', `\\\\wsl$\\Ubuntu\\home\\example\\.claude\\projects\\-home-repo\\${ID}.jsonl`],
    [
      'an Orca-managed account on macOS',
      `/Users/example/Library/Application Support/orca/claude-profiles/${PROFILE}/home/projects/${ENCODED_CWD}/${ID}.jsonl`
    ],
    [
      'an Orca-managed account on Windows',
      `C:\\Users\\example\\AppData\\Roaming\\orca\\claude-profiles\\${PROFILE}\\home\\projects\\C--repo\\${ID}.jsonl`
    ],
    [
      'an Orca-managed account in a WSL guest',
      `/home/example/.local/share/orca/claude-profiles/${PROFILE}/home/projects/-home-repo/${ID}.jsonl`
    ]
  ])('reads a Claude project transcript on %s', (_name, transcriptPath) => {
    expect(transcriptLayoutAgent({ id: ID, transcriptPath })).toBe('claude')
  })

  it.each([
    ['no path', undefined],
    ['blank path', '   '],
    [
      'a rollout named for another id',
      `/h/.codex/sessions/2026/09/30/rollout-2026-09-30T00-00-00-${'0'.repeat(8)}.jsonl`
    ],
    [
      'a rollout with a distinct suffix after the id',
      `/h/.codex/sessions/2026/09/30/rollout-x-${ID}_other.jsonl`
    ],
    ['a compressed rollout', `/h/.codex/sessions/2026/09/30/${ROLLOUT}.zst`],
    ['a rollout outside the dated layout', `/h/.codex/sessions/${ROLLOUT}`],
    ['a rollout nested below the dated layout', `/h/.codex/sessions/2026/09/30/nested/${ROLLOUT}`],
    ['a Claude transcript named for another id', `/h/.claude/projects/${ENCODED_CWD}/other.jsonl`],
    [
      'a Claude subagent transcript',
      `/h/.claude/projects/${ENCODED_CWD}/parent/subagents/agent-${ID}.jsonl`
    ],
    [
      'a Claude subagent dir named by the id',
      `/h/.claude/projects/${ENCODED_CWD}/${ID}/subagents/x.jsonl`
    ],
    // Real Qoder hook capture: a Claude-shaped projects/ tree under a relocated config dir.
    [
      'a Qoder transcript',
      `/private/tmp/orca-qoder-probe/config/projects/-private-tmp-ws/${ID}.jsonl`
    ],
    ['a Qoder default home', `/Users/example/.qoder/projects/${ENCODED_CWD}/${ID}.jsonl`],
    ['a CodeBuddy default home', `/Users/example/.codebuddy/projects/${ENCODED_CWD}/${ID}.jsonl`],
    [
      'an Orca-managed account subagent transcript',
      `/d/claude-profiles/${PROFILE}/home/projects/${ENCODED_CWD}/parent/subagents/agent-${ID}.jsonl`
    ],
    [
      'a profile home with no account id',
      `/d/claude-profiles//home/projects/${ENCODED_CWD}/${ID}.jsonl`
    ],
    [
      'a home dir outside claude-profiles',
      `/d/accounts/${PROFILE}/home/projects/${ENCODED_CWD}/${ID}.jsonl`
    ],
    [
      'a Claude transcript under a relocated config dir',
      `/opt/claude-home/projects/${ENCODED_CWD}/${ID}.jsonl`
    ],
    [
      'an OMP transcript',
      `/Users/example/.omp/agent/sessions/-repo/2026-09-30T00-00-00_${ID}.jsonl`
    ],
    [
      'a Muse dated session log',
      `/Users/example/.local/share/muse/sessions/2026/09/30/${ID}/session.jsonl`
    ],
    [
      'a Pi transcript',
      `/Users/example/.pi/agent/sessions/--repo--/2026-09-30T00-00-00_${ID}.jsonl`
    ]
  ])('reads %s as no evidence', (_name, transcriptPath) => {
    expect(transcriptLayoutAgent({ id: ID, transcriptPath })).toBeUndefined()
  })
})

describe('codexRolloutThreadMatch', () => {
  it('separates an exact rollout name from one Codex suffixed', () => {
    expect(codexRolloutThreadMatch(`2026/09/30/${ROLLOUT}`, ID)).toBe('exact')
    expect(codexRolloutThreadMatch(`2026/09/30/${ROLLOUT}`, ID.toUpperCase())).toBe('exact')
    expect(codexRolloutThreadMatch(`2026/09/30/rollout-x-${ID}_suffix.jsonl`, ID)).toBe('suffixed')
    expect(codexRolloutThreadMatch(`2026/09/30/rollout-x-${ID}.json`, ID)).toBeNull()
    expect(codexRolloutThreadMatch('2026/09/30/rollout-x-other.jsonl', ID)).toBeNull()
  })
})
