// @vitest-environment happy-dom
// GH-ACTING-LINE: the source control panel says who pushes and PRs go out as, and offers Connect
// GitHub only when it falls back to Orca's bot for a viewer who hasn't connected.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudGitActing } from '@/components/cloud-workspaces/cloud-git-acting-copy'
import { CloudGitActingNoticeView } from './cloud-git-acting-notice'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function show(answer: CloudGitActing | null, onConnect = vi.fn()): Promise<HTMLElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root!.render(
      <TooltipProvider>
        <CloudGitActingNoticeView answer={answer} onConnect={onConnect} />
      </TooltipProvider>
    )
  )
  return container
}

const connectButton = (c: HTMLElement) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent === 'Connect GitHub') ?? null

describe('who pushes and PRs go out as, in source control', () => {
  it('a member: as @login, no action', async () => {
    const c = await show({
      githubActing: { actingAs: 'member', userId: 'u1', login: 'octo-dev' },
      you: { connected: true }
    })
    expect(c.textContent).toContain('Pushes and PRs go out as @octo-dev')
    expect(connectButton(c)).toBeNull()
  })

  it('the bot for a viewer who isn’t connected: Connect GitHub', async () => {
    const onConnect = vi.fn()
    const c = await show(
      {
        githubActing: { actingAs: 'bot', reason: 'sender_not_connected' },
        you: { connected: false }
      },
      onConnect
    )
    expect(c.textContent).toContain('Pushes and PRs go out as Orca bot')
    await act(async () => connectButton(c)!.click())
    expect(onConnect).toHaveBeenCalledTimes(1)
  })

  it('the bot after the hour lapsed, viewer connected: says why, no action', async () => {
    const c = await show({
      githubActing: { actingAs: 'bot', reason: 'window_expired' },
      you: { connected: true }
    })
    expect(c.textContent).toContain('no one has sent in the last hour')
    expect(connectButton(c)).toBeNull()
  })

  it('nobody has sent yet in a shared workspace: whoever sends next', async () => {
    const c = await show({
      githubActing: { actingAs: 'bot', reason: 'no_sender_yet' },
      you: { connected: true }
    })
    expect(c.textContent).toContain('whoever sends next, or Orca bot')
  })

  it('reconnect (the solo owner’s token expired) and not connected: bot with Connect GitHub', async () => {
    const c = await show({
      githubActing: { actingAs: 'bot', reason: 'reconnect' },
      you: { connected: false }
    })
    expect(c.textContent).toContain('Pushes and PRs go out as Orca bot')
    expect(connectButton(c)).not.toBeNull()
  })

  it('no actor (not GitHub, identities off, older control plane): nothing', async () => {
    for (const reason of ['off', 'not_github'] as const) {
      expect(
        (await show({ githubActing: { actingAs: 'bot', reason }, you: { connected: false } }))
          .textContent
      ).toBe('')
      await act(async () => root?.unmount())
    }
    expect((await show({ you: { connected: false } })).textContent).toBe('')
    expect((await show(null)).textContent).toBe('')
  })

  it('a workspace that changed owners: the bot for good, with no Connect GitHub', async () => {
    const c = await show({
      githubActing: { actingAs: 'bot', reason: 'transferred' },
      you: { connected: false }
    })
    expect(c.textContent).toContain(
      'Pushes and PRs go out as Orca bot (this workspace changed owners)'
    )
    expect(connectButton(c)).toBeNull()
  })
})
