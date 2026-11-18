// @vitest-environment happy-dom

import { withBotConnectorRuntime } from '../../../lib/bot-connector-host-calls.test-fixture'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ConfirmationDialogContext } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { refreshBotGitHub, stopAwaitingGitHub } from '@/lib/bot-github-state'
import type { Bot } from '../../../../../shared/bot-types'
import { BotGitHubCard } from './BotGitHubCard'

const openAppHttpLink = vi.hoisted(() => vi.fn())
vi.mock('@/lib/browser/navigation/app-http-link-open', async (actual) => ({
  ...(await actual<Record<string, unknown>>()),
  openAppHttpLink
}))
vi.mock('@/lib/bot-catalog', () => ({ updateBot: vi.fn(), readBots: () => [] }))

const bot: Bot = {
  id: 'bot-1',
  name: 'Ranger',
  hostId: 'local',
  folder: 'ranger',
  folderWorkspaceId: 'fw-1',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: {},
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}
const installUrl = 'https://connector.example/github/install?state=s'
const acme = { installationId: '7', accountLogin: 'acme', repositories: [{ fullName: 'acme/web' }] }

const confirm = vi.fn()

afterEach(() => {
  cleanup()
  stopAwaitingGitHub('local')
  Reflect.deleteProperty(window, 'api')
})

it('"Add repositories or organizations" opens GitHub’s install page per Orca’s link setting', async () => {
  const openUrl = vi.fn()
  const state = vi.fn().mockResolvedValue({
    ok: true,
    value: {
      installUrl,
      account: { userId: '42', login: 'dana' },
      installations: [acme],
      defaultBotId: null
    }
  })
  Object.assign(window, {
    api: withBotConnectorRuntime({ shell: { openUrl }, botGitHub: { state } })
  })
  await refreshBotGitHub('local')
  await act(async () => {
    render(
      <ConfirmationDialogContext.Provider value={confirm}>
        <BotGitHubCard bot={bot} installation={acme} />
      </ConfirmationDialogContext.Provider>
    )
  })
  fireEvent.keyDown(screen.getByRole('button', { name: 'GitHub actions' }), { key: 'Enter' })
  fireEvent.click(
    await screen.findByRole('menuitem', { name: 'Add repositories or organizations' })
  )
  expect(openAppHttpLink).toHaveBeenCalledWith(installUrl)
  expect(openUrl).not.toHaveBeenCalled()
})
