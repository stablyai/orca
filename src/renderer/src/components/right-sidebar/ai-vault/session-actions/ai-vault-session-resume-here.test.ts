import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

const { resumeInNewChat } = vi.hoisted(() => ({ resumeInNewChat: vi.fn() }))

vi.mock('@/store/index', () => ({
  useAppStore: { getState: () => ({ unifiedTabsByWorktree: {} }) }
}))
vi.mock('@/lib/bot-group-catalog-snapshot', () => ({ readBotGroups: () => [] }))
vi.mock('./ai-vault-session-resume-in-chat-launch', () => ({
  resumeAiVaultSessionInNewChat: resumeInNewChat
}))

import { resumeAiVaultSessionHere, type AiVaultResumeHere } from './ai-vault-session-resume-here'

const FOLDER_PATH = '/home/ada/notes'
const BASE_ID = `folder-repo::${FOLDER_PATH}`
const INSTANCE_ID = `${BASE_ID}::workspace:3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b`

const session: AiVaultSession = {
  id: 'claude:session-1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'session-1',
  title: 'Draft the outline',
  cwd: FOLDER_PATH,
  branch: null,
  model: null,
  filePath: '/home/ada/.claude/projects/-home-ada-notes/session-1.jsonl',
  codexHome: null,
  createdAt: null,
  updatedAt: '2026-06-24T10:00:00.000Z',
  modifiedAt: '2026-06-24T10:00:00.000Z',
  messageCount: 2,
  totalTokens: 42,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: "claude --resume 'session-1'",
  subagent: null
}

function hereIn(workspaceId: string): AiVaultResumeHere {
  return {
    tabId: 'chat-tab',
    workspaceId,
    agent: 'claude',
    dismiss: vi.fn(),
    confirm: vi.fn()
  }
}

describe('resumeAiVaultSessionHere', () => {
  beforeEach(() => {
    resumeInNewChat.mockReset()
  })

  it('continues a CLI conversation in a sibling workspace on the same folder', () => {
    const picked = resumeAiVaultSessionHere({
      session,
      here: hereIn(INSTANCE_ID),
      actions: {
        canJumpToOriginalPane: false,
        resumeInNewChatWorkspaceId: BASE_ID
      },
      jump: vi.fn()
    })

    expect(picked).toBeInstanceOf(Promise)
    expect(resumeInNewChat).toHaveBeenCalledWith(
      session,
      'claude',
      INSTANCE_ID,
      expect.any(String),
      expect.objectContaining({ afterTabId: 'chat-tab' })
    )
  })

  it('refuses a same-path workspace of another repo, which may live on another host', () => {
    const picked = resumeAiVaultSessionHere({
      session,
      here: hereIn(`remote-repo::${FOLDER_PATH}`),
      actions: {
        canJumpToOriginalPane: false,
        resumeInNewChatWorkspaceId: BASE_ID
      },
      jump: vi.fn()
    })

    expect(picked).toBe(false)
    expect(resumeInNewChat).not.toHaveBeenCalled()
  })
})
