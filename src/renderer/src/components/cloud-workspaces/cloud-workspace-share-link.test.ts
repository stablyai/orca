// Copy link says when teammates can't open the link yet, and offers Share with
// team to whoever can; a team workspace keeps the plain "Workspace link copied".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))
const shareLinks = vi.hoisted(() => ({ on: true }))
vi.mock('@/lib/orca-cloud/cloud-team-sharing-flag', () => ({
  cloudTeamSharingEnabled: () => shareLinks.on
}))

import { copyCloudWorkspaceLink } from './cloud-workspace-share-link'
import { rememberCloudWorkspaces } from './cloud-workspace-identity'

type Visibility = 'private' | 'team'
const workspace = (id: string, visibility: Visibility, access: 'owner' | 'granted' = 'owner') => ({
  id,
  number: 7,
  link: `orca://cloud/acme/W-7-${id}`,
  title: 'web',
  access,
  visibility,
  ownerUserId: 'u1',
  createdAt: 1,
  ownershipTransferredAt: null
})

const patch = vi.fn()
const writeClipboardText = vi.fn(async () => undefined)
let fetched: ReturnType<typeof workspace> | null = null

beforeEach(() => {
  Reflect.set(globalThis, 'window', {
    api: {
      ui: { writeClipboardText },
      cloudWorkspaces: {
        get: async () => (fetched ? { ok: true, value: fetched } : { ok: false }),
        patch
      }
    }
  })
})

afterEach(() => {
  vi.clearAllMocks()
  fetched = null
})

const remember = (w: ReturnType<typeof workspace>) =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the cache reads only these fields.
  rememberCloudWorkspaces([w as never])

describe('Copy link and who can open it', () => {
  it('a team workspace: the plain "Workspace link copied"', async () => {
    remember(workspace('sbx_team', 'team'))
    expect(await copyCloudWorkspaceLink('sbx_team')).toBe(true)
    expect(writeClipboardText).toHaveBeenCalledTimes(1)
    expect(toasts.success).toHaveBeenCalledWith('Workspace link copied')
    expect(toasts.warning).not.toHaveBeenCalled()
  })

  it('a private workspace: copied, says teammates can’t open it, and Share with team shares it', async () => {
    remember(workspace('sbx_priv', 'private'))
    patch.mockResolvedValueOnce({ ok: true, value: workspace('sbx_priv', 'team') })
    expect(await copyCloudWorkspaceLink('sbx_priv')).toBe(true)
    expect(writeClipboardText).toHaveBeenCalled()
    expect(toasts.success).not.toHaveBeenCalled()
    const [title, options] = toasts.warning.mock.calls[0]!
    expect(title).toBe('Link copied, but teammates can’t open it yet')
    expect(options.action.label).toBe('Share with team')
    await options.action.onClick()
    await vi.waitFor(() => expect(patch).toHaveBeenCalledWith('sbx_priv', { visibility: 'team' }))
    await vi.waitFor(() =>
      expect(toasts.success).toHaveBeenCalledWith('Shared with your team', expect.anything())
    )

    // Shared now: the next copy is the plain one.
    toasts.success.mockClear()
    await copyCloudWorkspaceLink('sbx_priv')
    expect(toasts.success).toHaveBeenCalledWith('Workspace link copied')
  })

  it('private but not the owner: says so, with no Share with team', async () => {
    remember(workspace('sbx_other', 'private', 'granted'))
    await copyCloudWorkspaceLink('sbx_other')
    const [, options] = toasts.warning.mock.calls[0]!
    expect(options.description).toContain('Only its owner can share it')
    expect(options.action).toBeUndefined()
  })

  it('visibility not cached: read from the control plane; no answer keeps the plain toast', async () => {
    fetched = workspace('sbx_new', 'private')
    await copyCloudWorkspaceLink('sbx_new')
    expect(toasts.warning).toHaveBeenCalledTimes(1)

    fetched = null
    await copyCloudWorkspaceLink('sbx_unknown')
    expect(toasts.success).toHaveBeenCalledWith('Workspace link copied')
  })

  it('a chat link on a private workspace says chat link', async () => {
    remember(workspace('sbx_chat', 'private'))
    await copyCloudWorkspaceLink('sbx_chat', 'chat-1')
    expect(toasts.warning.mock.calls[0]![0]).toBe(
      'Chat link copied, but teammates can’t open it yet'
    )
  })
})
