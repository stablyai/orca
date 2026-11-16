// @vitest-environment happy-dom
// GH-ACTING-LINE: the source control panel says who pushes and PRs go out as, and offers Connect
// GitHub only when it falls back to Orca's bot for a viewer who hasn't connected.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { CloudWorkspaceGitActor } from '../../../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { CloudGitActingNoticeView } from './cloud-git-acting-notice'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function show(
  answer: CloudWorkspaceGitActor | null,
  onConnect = vi.fn()
): Promise<HTMLElement> {
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
      gitActor: { kind: 'member', userId: 'u1', login: 'octo-dev' },
      viewerConnected: true
    })
    expect(c.textContent).toContain('Pushes and PRs go out as @octo-dev')
    expect(connectButton(c)).toBeNull()
  })

  it('the bot for a viewer who isn’t connected: Connect GitHub', async () => {
    const onConnect = vi.fn()
    const c = await show(
      { gitActor: { kind: 'bot', reason: 'no_connected_member' }, viewerConnected: false },
      onConnect
    )
    expect(c.textContent).toContain('Pushes and PRs go out as Orca bot')
    await act(async () => connectButton(c)!.click())
    expect(onConnect).toHaveBeenCalledTimes(1)
  })

  it('the bot after the hour lapsed, viewer connected: says why, no action', async () => {
    const c = await show({ gitActor: { kind: 'bot', reason: 'stale' }, viewerConnected: true })
    expect(c.textContent).toContain('no one has sent in the last hour')
    expect(connectButton(c)).toBeNull()
  })

  it('no actor (not GitHub, identities off, older control plane): nothing', async () => {
    expect((await show({ viewerConnected: false })).textContent).toBe('')
    expect((await show(null)).textContent).toBe('')
  })
})
