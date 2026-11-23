// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotHostOutage } from '../use-bot-host-outage'
import type { BotSlackSetupStep } from './use-bot-slack-setup'
import { SlackSetupProblemStep, slackSetupProblem } from './SlackSetupProblem'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const reconnecting: BotHostOutage = { kind: 'reconnecting', environmentId: 'build-box' }
const offline: BotHostOutage = { kind: 'offline', environmentId: 'build-box' }

function show(step: BotSlackSetupStep, outage: BotHostOutage | null = null) {
  const problem = slackSetupProblem(step, outage)
  if (!problem) {
    throw new Error(`no problem for ${JSON.stringify(step)}`)
  }
  const onNewLink = vi.fn()
  const onReplaceToken = vi.fn()
  act(() =>
    root.render(
      <SlackSetupProblemStep
        problem={problem}
        botName="Release Helper"
        hostName="build-box"
        onClose={() => {}}
        onNewLink={onNewLink}
        onReplaceToken={onReplaceToken}
      />
    )
  )
  const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim())
  const details = container.querySelector<HTMLButtonElement>('button[aria-expanded]')
  const panel = details && document.getElementById(details.getAttribute('aria-controls') ?? '')
  const click = (label: string) =>
    act(() =>
      [...container.querySelectorAll('button')]
        .find((b) => b.textContent?.trim() === label)!
        .click()
    )
  return {
    text: container.textContent ?? '',
    buttons,
    details,
    panel,
    click,
    onNewLink,
    onReplaceToken
  }
}

describe('Connect Slack error states', () => {
  it('waits for a reconnecting server instead of offering Try again', () => {
    const view = show({ kind: 'failed', code: 'cloud_error', teamId: 'T1' }, reconnecting)
    expect(view.text).toContain('Waiting for build-box to reconnect…')
    expect(view.buttons).toEqual(['Details', 'Close'])
    expect(view.panel?.textContent).toContain('code: cloud_error')
  })

  it('offers Reconnect once the server stopped retrying', () => {
    const view = show({ kind: 'failed', code: 'cloud_error' }, offline)
    expect(view.text).toContain('Orca can’t reach build-box.')
    expect(view.buttons).toEqual(['Details', 'Close', 'Reconnect'])
  })

  it('names a different Slack account and gets a new link for the same workspace', () => {
    const view = show({ kind: 'other-user', teamId: 'T1' })
    expect(view.text).toContain('A different Slack account approved the connection.')
    view.click('Get a new link')
    expect(view.onNewLink).toHaveBeenCalledWith('T1')
    expect(view.panel?.textContent).toContain('code: other_user')
  })

  it('says the link expired and gets a new one', () => {
    const view = show({ kind: 'expired', teamId: 'T1' })
    expect(view.text).toContain('The Slack link expired before the connection was approved.')
    view.click('Get a new link')
    expect(view.onNewLink).toHaveBeenCalledWith('T1')
  })

  it('sends a rejected token to the token step for its workspace, not Try again', () => {
    const view = show({ kind: 'failed', code: 'slack_refused', teamId: 'T1' })
    expect(view.text).toContain('Slack rejected this workspace’s token.')
    expect(view.buttons).not.toContain('Try again')
    view.click('Replace token')
    expect(view.onReplaceToken).toHaveBeenCalledWith('T1', false)
  })

  it('keeps a token this desktop handed over on this desktop when Slack rejects it', () => {
    const view = show({ kind: 'failed', code: 'slack_refused', teamId: 'T1', local: true })
    view.click('Replace token')
    expect(view.onReplaceToken).toHaveBeenCalledWith('T1', true)
  })

  it('keeps Details collapsed until opened, and keeps codes out of the main text', () => {
    const view = show({ kind: 'failed', code: 'slack_refused', teamId: 'T1' })
    expect(view.details?.getAttribute('aria-expanded')).toBe('false')
    expect(view.panel?.hidden).toBe(true)
    const mainText = view.text.replace(view.panel?.textContent ?? '', '')
    expect(mainText).not.toMatch(/slack_refused|code:|callback/)
    act(() => view.details!.click())
    expect(view.panel?.hidden).toBe(false)
    expect(view.panel?.textContent).toContain('computer: build-box')
  })

  it('leaves other failures, and this computer’s own sign-in, to the existing one-line message', () => {
    expect(slackSetupProblem({ kind: 'failed', code: 'cloud_unreachable' }, null)).toBeNull()
    expect(slackSetupProblem({ kind: 'failed', code: 'cloud_error' }, null)).toBeNull()
    expect(
      slackSetupProblem({ kind: 'failed', code: 'signed_out', local: true }, reconnecting)
    ).toBeNull()
  })
})
