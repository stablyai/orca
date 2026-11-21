// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotShareCandidateSummary } from '../../../../../shared/bots/bot-package'
import type { BotOwnedShare } from '../../../../../shared/bots/bot-share-status'
import { useAppStore } from '@/store'
import { ORCA_SIGNED_OUT, orcaSignIn } from '../orca-sign-in.test-fixture'
import { BotSharingPage } from '../settings-view/BotSharingPage'
import { BotSharePrepare } from '../../../../../shared/rpc-contract/bots-share-params'
import { BotShareFlow } from './BotShareFlow'

const calls = vi.hoisted(() => {
  const rpc: { method: string; params: Record<string, unknown> }[] = []
  const last: { value: unknown } = { value: undefined }
  const expired = new Set<string>()
  const shares: BotOwnedShare[] = []
  const statusReady: { promise?: Promise<void> } = {}
  const skills: BotShareCandidateSummary['available']['skills'] = []
  const leftOut: BotShareCandidateSummary['leftOut'] = []
  return {
    rpc,
    last,
    expired,
    shares,
    statusReady,
    digest: 'digest',
    failMemory: false,
    failStatus: false,
    memory: [{ topic: 'area-owners', lines: 3 }],
    skills,
    leftOut
  }
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
    botDigest: calls.digest,
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
    leftOut: calls.leftOut,
    notIncluded: [],
    rewritten: [],
    available: {
      soulLines: 1,
      skills: calls.skills,
      schedules: [],
      eventSuggestions: [],
      tools: [],
      memory: calls.memory
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
      if (params.memory && calls.failMemory) {
        throw new Error('Orca could not build this share.')
      }
      const built = candidate(
        Array.isArray(params.memory) && params.memory.includes('area-owners')
          ? 'reviewed-memory'
          : `c${calls.rpc.filter((call) => call.method === method).length}`
      )
      return params.last && calls.last.value
        ? { candidate: built, last: calls.last.value }
        : { candidate: built }
    }
    if (method === 'bots.share.status') {
      await calls.statusReady.promise
      if (calls.failStatus) {
        throw new Error('Service unavailable')
      }
      return { status: 'ok', value: calls.shares }
    }
    if (method === 'bots.share.stop') {
      return { status: 'ok', value: true }
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
  calls.failMemory = false
  calls.memory = [{ topic: 'area-owners', lines: 3 }]
  calls.skills = []
  calls.leftOut = []
  calls.failStatus = false
  calls.statusReady.promise = undefined
  calls.shares.length = 0
  calls.digest = 'digest'
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

function ownedShare(id: string, canonical: boolean): BotOwnedShare {
  return {
    id,
    url: `https://x/${id}`,
    name: 'bot-bot1',
    packageId: 'package-1',
    createdAt: '2026-11-09T15:12:00.000Z',
    canonical,
    pinnedVersionId: 'v',
    pinnedDigest: 'older'
  }
}

it('never publishes a candidate built for other picks after a rebuild fails', async () => {
  calls.failMemory = true
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Include memory' }))
  fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))

  await screen.findByRole('alert')
  expect(screen.getByRole('button', { name: 'Publish link' }).hasAttribute('disabled')).toBe(true)
})

it('lists a same-named skill that is left out with the folder it is in', async () => {
  calls.skills = [
    {
      name: 'changelog-style',
      description: 'House style',
      homePath: '.agents/skills/changelog-style'
    }
  ]
  calls.leftOut = [
    {
      kind: 'skill',
      name: 'changelog-style',
      why: 'duplicate',
      from: '.claude/skills/changelog-style'
    }
  ]
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: /Skills/ }))
  expect(
    await screen.findByText('Same name, in .claude/skills/changelog-style · not shared')
  ).toBeDefined()
})

it('lists a skill linked into a project from outside it unticked, with the project', async () => {
  calls.skills = [
    { name: 'deploy', description: 'Ship it', homePath: null },
    {
      name: 'electron',
      description: 'Drive the app',
      homePath: null,
      optInFrom: 'team-skills'
    }
  ]
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  const row = await screen.findByRole('button', { name: /Skills/ })
  expect(row.textContent).toContain('1 of 2')
  fireEvent.click(row)
  expect(await screen.findByText('Linked into team-skills from outside it')).toBeDefined()
  expect(screen.getByRole('checkbox', { name: 'electron' }).getAttribute('aria-checked')).toBe(
    'false'
  )
  expect(screen.getByRole('checkbox', { name: 'deploy' }).getAttribute('aria-checked')).toBe('true')
})

it('lists a skill with a symlink as not shared, and the Skills row still opens to it', async () => {
  calls.skills = []
  calls.leftOut = [{ kind: 'skill', name: 'deploy', why: 'link' }]
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  // Nothing shareable reads None, yet the row opens to show why.
  const row = await screen.findByRole('button', { name: /Skills/ })
  expect(row.textContent).toContain('None')
  fireEvent.click(row)
  expect(await screen.findByText('Has a symlink or hard link · not shared')).toBeDefined()
})

it('picks every memory file with Include memory, and All clears or picks them all', async () => {
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Include memory' }))
  const all = screen.getByRole('switch', { name: 'All' })
  const file = screen.getByRole('checkbox', { name: 'area-owners' })
  expect(all.getAttribute('aria-checked')).toBe('true')
  expect(file.getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText('1 of 1')).toBeDefined()
  // The page takes focus at its title, not on Cancel.
  expect(document.activeElement?.textContent).toContain('Memory')

  fireEvent.click(all)
  expect(all.getAttribute('aria-checked')).toBe('false')
  expect(file.getAttribute('aria-checked')).toBe('false')

  // The whole line ticks its file, once.
  fireEvent.click(screen.getByText('area-owners', { selector: 'span' }))
  expect(file.getAttribute('aria-checked')).toBe('true')
  expect(all.getAttribute('aria-checked')).toBe('true')

  fireEvent.click(screen.getByRole('button', { name: 'Preview area-owners' }))
  expect(await screen.findByRole('button', { name: 'Memory' })).toBeDefined()
})

it('caps Include memory and All when more files exist than a share can carry', async () => {
  calls.memory = Array.from({ length: 65 }, (_, index) => ({ topic: `m${index}`, lines: 1 }))
  const preparedMemory = () => {
    const params = calls.rpc.findLast(({ method }) => method === 'bots.share.prepare')?.params
    // What the runtime would accept: the real params schema, not the mock.
    const parsed = BotSharePrepare.safeParse(params)
    expect(parsed.success).toBe(true)
    return parsed.data?.memory
  }
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  fireEvent.click(await screen.findByRole('switch', { name: 'Include memory' }))
  await waitFor(() => expect(preparedMemory()).toHaveLength(64))
  const all = screen.getByRole('switch', { name: 'All' })
  expect(all.getAttribute('aria-checked')).toBe('true')

  fireEvent.click(all)
  fireEvent.click(all)
  await waitFor(() => expect(preparedMemory()).toHaveLength(64))
  // Past the limit, the files left over wait until one picked file goes.
  expect(screen.getByRole('checkbox', { name: 'm63' }).hasAttribute('disabled')).toBe(false)
  expect(screen.getByRole('checkbox', { name: 'm64' }).hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'm0' }))
  expect(screen.getByRole('checkbox', { name: 'm64' }).hasAttribute('disabled')).toBe(false)
})

it('leads with Done when the link already serves the bot as it is', async () => {
  render(<BotShareFlow bot={bot} link={link('digest')} onClose={() => {}} />)

  expect(await screen.findByText(/Up to date/)).toBeDefined()
  expect(screen.getByRole('button', { name: 'Update link' }).hasAttribute('disabled')).toBe(true)
})

it('updates the link from the picks and note it was last published with', async () => {
  calls.last.value = { selection: { skills: [] }, setupNote: 'Connect Slack first.' }
  const previousLink = link('older')
  const onClose = () => {}
  const view = render(<BotShareFlow bot={bot} link={previousLink} onClose={onClose} />)
  // Update link is live only once the share's last picks are read back.
  await screen.findByText(/Bot changed since/)
  view.rerender(<BotShareFlow bot={{ ...bot }} link={previousLink} onClose={onClose} />)
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

it('keeps the reviewed parts and setup note through sign-in and publishes that draft', async () => {
  const initial = useAppStore.getState()
  const connect = vi.fn(orcaSignIn())
  useAppStore.setState({
    orcaProfileAuthStatus: ORCA_SIGNED_OUT,
    connectCurrentOrcaProfile: connect
  })
  try {
    render(<BotSharingPage bot={bot} />)
    fireEvent.click(screen.getByRole('button', { name: 'Share bot…' }))
    fireEvent.click(await screen.findByRole('switch', { name: 'Include memory' }))
    // Turning memory on picks every file; the list opens to leave some out.
    expect(screen.getByRole('checkbox', { name: 'area-owners' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))
    fireEvent.click(await screen.findByRole('button', { name: /Setup note/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Setup note' }), {
      target: { value: 'Connect GitHub before the first run.' }
    })
    expect(connect).not.toHaveBeenCalled()
    expect(calls.rpc.some(({ method }) => method === 'bots.share.publish')).toBe(false)
    fireEvent.click(await readyButton('Sign in to publish'))
    await readyButton('Publish link')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Setup note' }).value).toBe(
      'Connect GitHub before the first run.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))
    expect(
      screen.getByRole('switch', { name: 'Include memory' }).getAttribute('aria-checked')
    ).toBe('true')
    fireEvent.click(await readyButton('Publish link'))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined()
    expect(clipboard).toHaveBeenCalledWith('https://x/s1')
    expect(calls.rpc.find(({ method }) => method === 'bots.share.publish')?.params).toEqual({
      botId: 'bot-1',
      candidateId: 'reviewed-memory',
      setupNote: 'Connect GitHub before the first run.'
    })
  } finally {
    useAppStore.setState(initial, true)
  }
})

it('opens the preview before link status settles and recovers from a failed check', async () => {
  const status = Promise.withResolvers<void>()
  calls.statusReady.promise = status.promise
  calls.failStatus = true
  render(<BotSharingPage bot={bot} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Share bot…' }))

  const preview = within(screen.getByRole('dialog'))
  await preview.findByRole('button', { name: /Setup note/ })
  status.resolve()
  const retry = await preview.findByRole('button', { name: 'Retry' })
  expect(preview.getByRole('button', { name: 'Publish link' }).hasAttribute('disabled')).toBe(true)

  calls.failStatus = false
  fireEvent.click(retry)
  await readyButton('Publish link')
  fireEvent.click(preview.getByRole('button', { name: 'Cancel' }))
  expect(screen.getByRole('button', { name: 'Manage links' })).toBeDefined()
})

it('restores saved selections for an existing link while preserving an edited setup note', async () => {
  const initial = useAppStore.getState()
  useAppStore.setState({
    orcaProfileAuthStatus: ORCA_SIGNED_OUT,
    connectCurrentOrcaProfile: orcaSignIn()
  })
  calls.shares.push(ownedShare('s1', true))
  calls.last.value = { selection: { memory: ['area-owners'] }, setupNote: 'Connect Slack first.' }
  try {
    render(<BotShareFlow bot={bot} onClose={() => {}} />)
    fireEvent.click(await screen.findByRole('button', { name: /Setup note/ }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Setup note' }), {
      target: { value: 'Connect GitHub first.' }
    })
    fireEvent.click(await readyButton('Sign in to publish'))

    await readyButton('Update link')
    expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Setup note' }).value).toBe(
      'Connect GitHub first.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))
    expect(
      screen.getByRole('switch', { name: 'Include memory' }).getAttribute('aria-checked')
    ).toBe('true')
  } finally {
    useAppStore.setState(initial, true)
  }
})

it('keeps the selected older link when signing in to stop it', async () => {
  const initial = useAppStore.getState()
  useAppStore.setState({
    orcaProfileAuthStatus: ORCA_SIGNED_OUT,
    connectCurrentOrcaProfile: orcaSignIn()
  })
  calls.shares.push(ownedShare('s2', true), ownedShare('s1', false))
  const close = vi.fn()
  try {
    render(<BotShareFlow bot={bot} link={link('older')} start="stop" onClose={close} />)
    fireEvent.click(await readyButton('Sign in'))
    fireEvent.click(await readyButton('Stop sharing'))

    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(calls.rpc.find(({ method }) => method === 'bots.share.stop')?.params).toEqual({
      shareId: 's1',
      botId: 'bot-1'
    })
  } finally {
    useAppStore.setState(initial, true)
  }
})

it('keeps publication disabled when the selected link is gone after sign-in', async () => {
  const initial = useAppStore.getState()
  useAppStore.setState({
    orcaProfileAuthStatus: ORCA_SIGNED_OUT,
    connectCurrentOrcaProfile: orcaSignIn()
  })
  calls.shares.push(ownedShare('s2', true))
  try {
    render(<BotShareFlow bot={bot} shareId="s1" start="update" onClose={() => {}} />)
    fireEvent.click(await readyButton('Sign in to publish'))

    await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByRole('button', { name: 'Publish link' }).hasAttribute('disabled')).toBe(true)
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

it('waits for another publish click when an expired preview rebuilds with different contents', async () => {
  calls.expired.add('c1')
  render(<BotShareFlow bot={bot} link={null} onClose={() => {}} />)
  const publish = await readyButton('Publish link')
  calls.digest = 'changed-digest'
  fireEvent.click(publish)

  await screen.findByRole('alert')
  expect(clipboard).not.toHaveBeenCalled()
  expect(
    calls.rpc.find(
      ({ method, params }) => method === 'bots.share.publish' && params.candidateId === 'c2'
    )
  ).toBeUndefined()
  fireEvent.click(await readyButton('Publish link'))
  expect(await screen.findByRole('button', { name: 'Copied' })).toBeDefined()
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
