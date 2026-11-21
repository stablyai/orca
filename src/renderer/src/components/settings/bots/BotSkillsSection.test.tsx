// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../../shared/bot-types'
import { BotSkillsSection } from './BotSkillsSection'

// A host from an earlier development build sends its own skills without `loadedBy`.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_host: unknown, method: string, params: Record<string, unknown>) =>
    method === 'bots.skillProjects.scan'
      ? {
          projects: [],
          ...(params.botId
            ? {
                own: {
                  skillsDir: '/home/skills',
                  skills: [
                    { name: 'deploy', description: 'Ship it', folder: '/home/skills/deploy' }
                  ],
                  agentOnly: []
                }
              }
            : {})
        }
      : {}
}))

afterEach(cleanup)

const bot: Bot = {
  id: 'bot-1',
  name: 'Scout',
  hostId: 'local',
  folder: 'scout',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

it('lists an own skill with no agent label when its host does not say which agents load it', async () => {
  render(
    <TooltipProvider>
      <BotSkillsSection bot={bot} onChange={() => {}} />
    </TooltipProvider>
  )
  expect(await screen.findByText('deploy')).toBeInTheDocument()
  for (const label of ['Claude only', 'Not for Claude', 'No agent loads it']) {
    expect(screen.queryByText(label)).toBeNull()
  }
})
