import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { getAgentForkArgv } from './agent-session-resume'
import { resumeRecordFromStatus } from './agent-resume-record-from-status'
import {
  buildClaudeSideChatSettings,
  buildClaudeSideChatStartup,
  CLAUDE_SIDE_CHAT_CONTEXT,
  createClaudeSideChatSessionId,
  isClaudeSideChatSessionId
} from './claude-side-chat'

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
        additionalContext: CLAUDE_SIDE_CHAT_CONTEXT
      })
    }
  )
})
