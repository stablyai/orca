import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { getAgentForkArgv } from '../startup/agent-resume-argv'
import { resumeRecordFromStatus } from '../../agent-session/lifecycle/agent-resume-record-from-status'
import {
  buildClaudeSideChatSettings,
  buildClaudeSideChatStartup,
  createClaudeSideChatSessionId,
  isClaudeSideChatSessionId
} from './claude-side-chat'
import { SIDE_CHAT_CONTEXT } from './side-chat'
import { buildSideChatStartup } from './side-chat-startup'

const PARENT = {
  key: 'session_id',
  id: '1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed',
  cwd: '/work/repo',
  effort: 'high'
} as const
const SIDE_ID = createClaudeSideChatSessionId('7f2c1e9a-0d3b-4c5e-8f6a-1b2c3d4e5f60')

describe('Claude side chat', () => {
  it('mints UUIDs that only side chats carry', () => {
    expect(SIDE_ID).toMatch(/^05ca51de-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(isClaudeSideChatSessionId(SIDE_ID)).toBe(true)
    expect(isClaudeSideChatSessionId(PARENT.id)).toBe(false)
  })

  it('never resumes or forks a side chat, which has no transcript', () => {
    const side = { key: 'session_id', id: SIDE_ID } as const
    expect(
      resumeRecordFromStatus({
        entry: {
          paneKey: 'tab:leaf',
          agentType: 'claude',
          state: 'working',
          prompt: '',
          updatedAt: 1,
          providerSession: side
        },
        worktreeId: 'wt',
        capturedAt: 1
      })
    ).toBeNull()
    expect(getAgentForkArgv('claude', side)).toBeNull()
    expect(
      buildClaudeSideChatStartup({
        parentSession: side,
        sideSessionId: createClaudeSideChatSessionId('9c4f7a1e-2b3d-4e5f-9a6b-7c8d9e0f1a2b'),
        host: { platform: 'darwin', liveShell: undefined },
        settings: null
      })
    ).toBeNull()
  })

  it('forks the parent ephemerally in its folder with its effort and model', () => {
    const startup = buildClaudeSideChatStartup({
      parentSession: PARENT,
      sideSessionId: SIDE_ID,
      host: { platform: 'darwin', liveShell: undefined },
      settings: null,
      model: 'claude-opus-5-5[1m]',
      draftPrompt: '> quoted\n\n'
    })

    expect(startup?.command).toContain("cd '/work/repo'")
    expect(startup?.command).toContain(
      `'--resume' '${PARENT.id}' '--fork-session' '--session-id' '${SIDE_ID}' '--settings'`
    )
    expect(startup?.command).toContain(
      "'--effort' 'high' '--model' 'claude-opus-5-5[1m]' '--prefill' '> quoted\n\n'"
    )
  })

  it.skipIf(process.platform === 'win32')(
    'injects the boundary through a hook whose output Claude can parse',
    () => {
      const settings = JSON.parse(buildClaudeSideChatSettings())
      expect(settings.env).toEqual({ CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' })
      const [hook] = settings.hooks.SessionStart
      expect(hook.matcher).toBe('fork')
      const output = execFileSync('sh', ['-c', hook.hooks[0].command], { encoding: 'utf8' })
      expect(JSON.parse(output).hookSpecificOutput).toEqual({
        hookEventName: 'SessionStart',
        additionalContext: SIDE_CHAT_CONTEXT
      })
    }
  )
})

const OMP_PARENT_PATH =
  '/home/u/.omp/agent/sessions/-work-repo/2026-11-10T10-00-00-000Z_01a1c093.jsonl'
const OMP_SIDE_DIR = '/home/u/.omp/agent/sessions/-work-repo/.orca-side-chats/side-1'
const OMP_PARENT = {
  agentType: 'omp',
  providerSession: { key: 'session_id', id: '01a1c093', transcriptPath: OMP_PARENT_PATH },
  model: 'anthropic/claude-opus-5-5',
  prompt: 'fix the build'
} as const
const HOST = { platform: 'linux', liveShell: undefined } as const

describe('omp side chat', () => {
  it('forks the parent transcript into its own side-chat folder and hands the folder to the extension', () => {
    const startup = buildSideChatStartup({
      parent: OMP_PARENT,
      sideChatId: 'side-1',
      host: HOST,
      settings: null,
      draftPrompt: '> quoted\n\n'
    })

    expect(startup?.command).toBe(
      `omp '--fork' '${OMP_PARENT_PATH}' '--session-dir' '${OMP_SIDE_DIR}'`
    )
    expect(startup?.env).toEqual({
      ORCA_OMP_SIDE_CHAT_DIR: OMP_SIDE_DIR,
      ORCA_OMP_PREFILL: '> quoted\n\n'
    })
  })

  it('keeps a Windows parent path in its own separator', () => {
    const startup = buildSideChatStartup({
      parent: {
        ...OMP_PARENT,
        providerSession: {
          ...OMP_PARENT.providerSession,
          transcriptPath: 'C:\\Users\\u\\.omp\\agent\\sessions\\p\\s.jsonl'
        }
      },
      sideChatId: 'side-1',
      host: HOST,
      settings: null
    })
    expect(startup?.env?.ORCA_OMP_SIDE_CHAT_DIR).toBe(
      'C:\\Users\\u\\.omp\\agent\\sessions\\p\\.orca-side-chats\\side-1'
    )
  })

  it('waits for the first prompt, since omp has no transcript to fork before it', () => {
    expect(
      buildSideChatStartup({
        parent: { ...OMP_PARENT, prompt: '' },
        sideChatId: 'side-1',
        host: HOST,
        settings: null
      })
    ).toBeNull()
  })

  it('never resumes, forks, or nests a side chat', () => {
    const side = {
      key: 'session_id',
      id: '01a1c5b5',
      transcriptPath: `${OMP_SIDE_DIR}/x.jsonl`
    } as const
    expect(
      resumeRecordFromStatus({
        entry: {
          paneKey: 'tab:leaf',
          agentType: 'omp',
          state: 'done',
          prompt: 'why?',
          updatedAt: 1,
          providerSession: side
        },
        worktreeId: 'wt',
        capturedAt: 1
      })
    ).toBeNull()
    expect(
      buildSideChatStartup({
        parent: { ...OMP_PARENT, providerSession: side },
        sideChatId: 'side-2',
        host: HOST,
        settings: null
      })
    ).toBeNull()
  })
})
