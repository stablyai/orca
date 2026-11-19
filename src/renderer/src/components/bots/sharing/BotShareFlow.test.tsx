// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'
import { useAppStore } from '@/store'
import { ORCA_SIGNED_OUT, orcaSignIn } from '../orca-sign-in.test-fixture'
import { BotShareFlow } from './BotShareFlow'

const calls = vi.hoisted(() => {
  const rpc: { method: string; params: Record<string, unknown> }[] = []
  const last: { value: unknown } = { value: undefined }
  const expired = new Set<string>()
  return { rpc, last, expired }
})

const bot: Bot = {
  id: 'bot-1',
  name: 'Release notes',
  hostId: 'local',
  folder: 'release-notes',
  folderWorkspaceId: 'release-notes-home',
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

function candidate(id: string): BotShareCandidateSummary {
  return {
    candidateId: id,
    packageId: 'package-1',
    versionId: `version-${id}`,
    botDigest: 'digest',
    archiveSha256: 'sha',
    compressedBytes: 1,
    fileCount: 1,
    totalBytes: 1,
    bot: {
      schemaVersion: 1,
      name: 'Release notes',
      purpose: 'Drafts release notes.',
      agentHint: 'claude',
      skills: [],
      tools: [],
      connectors: [],
      schedules: [],
      eventSuggestions: [],
      memory: []
    },
    files: [],
    leftOut: [],
    notIncluded: [],
    rewritten: [],
    available: {
      soulLines: 1,
      skills: [],
      schedules: [],
      eventSuggestions: [],
      tools: [],
      memory: [{ topic: 'area-owners', lines: 3 }]
    },
    automationIds: { schedules: [], eventSuggestions: [] },
    flags: [],
    blocked: false,
    expiresAt: '2026-11-08T01:00:00.000Z'
  }
}

// The runtime boundary: prepare builds a candidate per call; publish answers with a link.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (_host: unknown, method: string, params: Record<string, unknown>) => {
    calls.rpc.push({ method, params })
    if (method === 'bots.share.prepare') {
      if (params.memory) {
        throw new Error('Orca could not build this share.')
      }
      const built = candidate(`c${calls.rpc.filter((call) => call.method === method).length}`)
      return params.last && calls.last.value
        ? { candidate: built, last: calls.last.value }
        : { candidate: built }
    }
    if (method === 'bots.share.status') {
      return { status: 'ok', value: [] }
    }
    if (method === 'bots.share.publish' && calls.expired.has(String(params.candidateId))) {
      throw new Error('bot_share_preview_expired')
    }
    return {
      status: 'ok',
      value: {
        share: { id: 's1', url: 'https://x/s1', pinnedVersionId: 'v' },
        version: { versionId: 'v', packageDigest: 'digest' }
      }
    }
  }
}))

const clipboard = vi.fn(async () => {})

afterEach(() => {
  cleanup()
  calls.rpc.length = 0
  calls.last.value = undefined
  calls.expired.clear()
  clipboard.mockClear()
})

Reflect.set(window, 'api', { ui: { writeClipboardText: clipboard } })

/** The footer button once the candidate it publishes is built; it shows disabled until then. */
async function readyButton(name: string): Promise<HTMLElement> {
  const button = await screen.findByRole('button', { name })
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false))
  return button
}

const link = (digest: string | null) => ({
  shareId: 's1',
  url: 'https://x/s1',
  versionId: 'v',
  updatedAt: '2026-11-09T15:12:00.000Z',
  digest
})

it('publishes the reviewed candidate with the note on screen and copies the new link', async () => {
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: /Setup note/ }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Setup note' }), {
    target: { value: 'Connect GitHub before the first run.' }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Publish link' }))

  expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined()
  expect(clipboard).toHaveBeenCalledWith('https://x/s1')
  expect(calls.rpc.map(({ method }) => method)).toEqual([
    'bots.share.prepare',
    'bots.share.publish'
  ])
  expect(calls.rpc[1]?.params).toEqual({
    botId: 'bot-1',
    candidateId: 'c1',
    setupNote: 'Connect GitHub before the first run.'
  })
})

it('never publishes a candidate built for other picks after a rebuild fails', async () => {
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Include memory' }))
  fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))

  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Publish link' }).hasAttribute('disabled')).toBe(true)
})

it('leads with Done when the link already serves the bot as it is', async () => {
  render(<BotShareFlow bot={bot} link={link('digest')} onClose={() => {}} />)

  expect(await screen.findByText(/Up to date/)).toBeDefined()
  expect(screen.getByRole('button', { name: 'Update link' }).hasAttribute('disabled')).toBe(true)
})

it('offers Update link once the bot changed since the link was published', async () => {
  render(<BotShareFlow bot={bot} link={link('older')} onClose={() => {}} />)

  expect(await screen.findByText(/Bot changed since/)).toBeDefined()
  expect(screen.getByRole('button', { name: 'Update link' }).hasAttribute('disabled')).toBe(false)
})

it('updates the link from the picks and note it was last published with', async () => {
  calls.last.value = { selection: { skills: [] }, setupNote: 'Connect Slack first.' }
  render(<BotShareFlow bot={bot} link={link('older')} onClose={() => {}} />)
  // Update link is live only once the share's last picks are read back.
  await screen.findByText(/Bot changed since/)
  fireEvent.click(screen.getByRole('button', { name: 'Update link' }))

  expect(await screen.findByText('Updated just now')).toBeDefined()
  expect(calls.rpc[0]?.params).toEqual({ botId: 'bot-1', last: true })
  expect(calls.rpc[1]?.params).toEqual({
    botId: 'bot-1',
    candidateId: 'c1',
    setupNote: 'Connect Slack first.',
    link: { shareId: 's1', expectedVersionId: 'v' }
  })
  expect(clipboard).not.toHaveBeenCalled()
})

it('asks a signed-out owner to sign in before building anything, then shows the share', async () => {
  const initial = useAppStore.getState()
  useAppStore.setState({
    orcaProfileAuthStatus: ORCA_SIGNED_OUT,
    connectCurrentOrcaProfile: orcaSignIn()
  })
  try {
    render(<BotShareFlow bot={bot} onClose={() => {}} />)
    expect(
      screen.getByText('Sharing goes through Orca Cloud. Sign in to Orca to continue.')
    ).toBeDefined()
    expect(calls.rpc).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByRole('button', { name: 'Publish link' })).toBeDefined()
  } finally {
    useAppStore.setState(initial, true)
  }
})

it('publishes the rebuilt candidate when the shown one expired', async () => {
  calls.expired.add('c1')
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  fireEvent.click(await readyButton('Publish link'))

  expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined()
  expect(
    calls.rpc
      .filter(({ method }) => method === 'bots.share.publish')
      .map(({ params }) => params.candidateId)
  ).toEqual(['c1', 'c2'])
})

it('starts a bot without a live link from the defaults, not its last published picks', async () => {
  calls.last.value = { selection: { memory: ['area-owners'] }, setupNote: 'Old note.' }
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)

  await readyButton('Publish link')
  expect(calls.rpc[0]?.params).toEqual({ botId: 'bot-1', setupNote: '' })
  expect(screen.getByRole('switch', { name: 'Include memory' }).getAttribute('aria-checked')).toBe(
    'false'
  )
})
