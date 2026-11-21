import { describe, expect, it } from 'vitest'
import { resolveResumeLaunchRecipe } from './resume-launch-recipe'

const ACCOUNT_ID = '7f7f1e7c-1c2d-4e5f-8a9b-0c1d2e3f4a5b'
const SESSION_ID = 'ea8dbad6-1234-5678-9abc-def012345678'
const AUTH_DIR = `/home/dev/.local/share/orca/claude-accounts/${ACCOUNT_ID}/auth`
const TRANSCRIPT = `${AUTH_DIR}/projects/-home-dev-repo/${SESSION_ID}.jsonl`

describe('resolveResumeLaunchRecipe managed Claude account env', () => {
  it('restores CLAUDE_CONFIG_DIR from a managed transcript when the saved record has no env', () => {
    expect(
      resolveResumeLaunchRecipe(undefined, 'claude', {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: TRANSCRIPT
      }).agentEnv
    ).toEqual({ CLAUDE_CONFIG_DIR: AUTH_DIR })
  })

  it('restores CLAUDE_CONFIG_DIR alongside the recorded recipe', () => {
    const recipe = resolveResumeLaunchRecipe(
      {
        agentCommand: "claude '--dangerously-skip-permissions'",
        agentArgs: '--dangerously-skip-permissions',
        agentEnv: {}
      },
      'claude',
      { key: 'session_id', id: SESSION_ID, transcriptPath: TRANSCRIPT }
    )
    expect(recipe).toEqual({
      agentCommand: "claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: { CLAUDE_CONFIG_DIR: AUTH_DIR }
    })
  })

  it('keeps a CLAUDE_CONFIG_DIR the record already carries', () => {
    expect(
      resolveResumeLaunchRecipe(
        { agentArgs: '', agentEnv: { CLAUDE_CONFIG_DIR: '/home/dev/custom-claude' } },
        'claude',
        { key: 'session_id', id: SESSION_ID, transcriptPath: TRANSCRIPT }
      ).agentEnv
    ).toEqual({ CLAUDE_CONFIG_DIR: '/home/dev/custom-claude' })
  })

  it('leaves the default ~/.claude transcript unchanged', () => {
    expect(
      resolveResumeLaunchRecipe(undefined, 'claude', {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: `/home/dev/.claude/projects/-home-dev-repo/${SESSION_ID}.jsonl`
      }).agentEnv
    ).toEqual({})
  })

  it('leaves other agents unchanged even with a managed transcript', () => {
    expect(
      resolveResumeLaunchRecipe(undefined, 'codex', {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: TRANSCRIPT
      }).agentEnv
    ).toEqual({})
  })

  it('preserves Windows separators in the restored config dir', () => {
    const windowsAuth = `C:\\Users\\dev\\AppData\\Roaming\\orca\\claude-accounts\\${ACCOUNT_ID}\\auth`
    expect(
      resolveResumeLaunchRecipe(undefined, 'claude', {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: `${windowsAuth}\\projects\\-repo\\${SESSION_ID}.jsonl`
      }).agentEnv
    ).toEqual({ CLAUDE_CONFIG_DIR: windowsAuth })
  })

  it('leaves a missing transcript path unchanged', () => {
    expect(
      resolveResumeLaunchRecipe(undefined, 'claude', { key: 'session_id', id: SESSION_ID }).agentEnv
    ).toEqual({})
  })

  it('leaves a non-managed config dir under projects unchanged', () => {
    expect(
      resolveResumeLaunchRecipe(undefined, 'claude', {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: `/home/dev/.local/share/orca/claude-profiles/${ACCOUNT_ID}/home/projects/-repo/${SESSION_ID}.jsonl`
      }).agentEnv
    ).toEqual({})
  })

  it('refuses a malformed account id in a claude-accounts auth path', () => {
    expect(
      resolveResumeLaunchRecipe(undefined, 'claude', {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: `/home/dev/.local/share/orca/claude-accounts/bad..id/auth/projects/-repo/${SESSION_ID}.jsonl`
      }).agentEnv
    ).toEqual({})
  })

  it('refuses a path nested below auth as a managed account root', () => {
    expect(
      resolveResumeLaunchRecipe(undefined, 'claude', {
        key: 'session_id',
        id: SESSION_ID,
        transcriptPath: `${AUTH_DIR}/archive/projects/-repo/${SESSION_ID}.jsonl`
      }).agentEnv
    ).toEqual({})
  })
})
