// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { stampBotHost } from '@/lib/bot-catalog-snapshot'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { Bot } from '../../../../../shared/bot-types'
import { SlackApproveStep } from './SlackApproveStep'
import { SlackReconnectStep } from './SlackReconnectStep'
import { SlackHandOffOfferStep } from './slack-hand-off-parts'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  useAppStore.setState({
    settings: { ...getDefaultSettings('/fixture'), machineName: 'MacBook Pro' }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const buttons = () => [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
const click = (label: string) =>
  act(() =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!.click()
  )
const visibleText = () => {
  const clone = container.cloneNode(true)
  if (!(clone instanceof HTMLElement)) {
    return ''
  }
  clone.querySelectorAll('[hidden]').forEach((node) => node.remove())
  return clone.textContent ?? ''
}

const bot: Bot = stampBotHost('runtime:m4-air', {
  id: 'bot-release',
  name: 'Release Helper',
  hostId: 'local',
  folder: 'release',
  folderWorkspaceId: 'fw-release',
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
})

describe('1a: Slack sign-in expired on the bot’s computer', () => {
  function show() {
    const onUse = vi.fn()
    act(() =>
      root.render(
        <TooltipProvider>
          <SlackReconnectStep
            bot={bot}
            hostName="m4-air"
            offer={{ email: 'alex@example.com', teamId: 'T1' }}
            mine={false}
            ownEmail="alex@example.com"
            error={null}
            onUse={onUse}
            onSubmit={() => {}}
            onCancel={() => {}}
          />
        </TooltipProvider>
      )
    )
    return { onUse }
  }

  it('asks one question with two buttons, naming this computer and no account', () => {
    const { onUse } = show()
    expect(visibleText()).toContain('Use your MacBook Pro’s Slack sign-in instead?')
    expect(visibleText()).not.toContain('alex@example.com')
    expect(buttons().filter((label) => label !== '')).toEqual(
      expect.arrayContaining(['Sign in again', 'Use MacBook Pro’s sign-in'])
    )
    click('Use MacBook Pro’s sign-in')
    expect(onUse).toHaveBeenCalledWith('T1')
  })

  it('Sign in again shows the token form, and Cancel goes back to the question', () => {
    show()
    expect(container.querySelector('input')?.closest('[hidden]')).not.toBeNull()
    click('Sign in again')
    expect(container.querySelector('input')?.closest('[hidden]')).toBeNull()
    expect(visibleText()).not.toContain('Use your MacBook Pro’s Slack sign-in instead?')
    click('Cancel')
    expect(visibleText()).toContain('Use your MacBook Pro’s Slack sign-in instead?')
  })
})

describe('1b: first Slack setup with this computer’s sign-in', () => {
  it('leads with this computer’s sign-in, the token form behind Set up another way', () => {
    const onUse = vi.fn()
    const onAnotherWay = vi.fn()
    act(() =>
      root.render(<SlackHandOffOfferStep teamId="T1" onUse={onUse} onAnotherWay={onAnotherWay} />)
    )
    expect(container.textContent).toContain(
      'Your MacBook Pro is already signed in to Slack. Use that sign-in?'
    )
    expect(buttons()).toEqual(['Set up another way', 'Use MacBook Pro’s sign-in'])
    click('Set up another way')
    expect(onAnotherWay).toHaveBeenCalled()
    click('Use MacBook Pro’s sign-in')
    expect(onUse).toHaveBeenCalledWith('T1')
  })
})

describe('2a/2b: the Slack approval link', () => {
  const link = {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize?client_id=1&state=s',
    expiresAt: new Date(2026, 10, 22, 16, 42).getTime()
  }

  function show(copied: boolean) {
    const onOpen = vi.fn()
    const onCopy = vi.fn(async () => {})
    act(() =>
      root.render(
        <SlackApproveStep
          hostName="m4-air"
          link={link}
          copied={copied}
          onOpen={onOpen}
          onCopy={onCopy}
          onNewLink={() => {}}
        />
      )
    )
    const toggle = [...container.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Approve on another device'
    )!
    const panel = document.getElementById(toggle.getAttribute('aria-controls') ?? '')!
    return { onOpen, onCopy, toggle, panel }
  }

  it('2a: opens Slack on the bot’s computer, with nothing under the button and the link folded away', () => {
    const view = show(false)
    expect(buttons()[0]).toBe('Open Slack on m4-air')
    expect(view.toggle.getAttribute('aria-expanded')).toBe('false')
    expect(view.panel.hidden).toBe(true)
    expect(visibleText()).toBe(
      'Your Slack app is ready. Approve it in Slack to finish.Open Slack on m4-airApprove on another device'
    )
    click('Open Slack on m4-air')
    expect(view.onOpen).toHaveBeenCalled()
  })

  it('2a expanded: the link, Copy link, and when it stops working', () => {
    const view = show(false)
    act(() => view.toggle.click())
    expect(view.panel.hidden).toBe(false)
    expect(view.panel.querySelector('input')?.value).toBe(link.authorizeUrl)
    expect(view.panel.textContent).toMatch(/Works once, until 4:42\sPM\./)
    expect(view.panel.textContent).not.toContain('Waiting for Slack')
    click('Copy link')
    expect(view.onCopy).toHaveBeenCalled()
  })

  it('a link copied by hand from the field counts as Copy link', () => {
    const view = show(false)
    act(() => view.toggle.click())
    act(() => {
      view.panel.querySelector('input')!.dispatchEvent(new Event('copy', { bubbles: true }))
    })
    expect(view.onCopy).toHaveBeenCalledWith(true)
  })

  it('2b: after Copy link the section stays open, says Copied, and waits for Slack', () => {
    const view = show(true)
    expect(view.panel.hidden).toBe(false)
    expect(buttons()).toContain('Copied')
    expect(buttons()).not.toContain('Copy link')
    expect(view.panel.querySelector('[role="status"]')?.textContent).toBe(
      'Waiting for Slack…Get a new link'
    )
  })
})
