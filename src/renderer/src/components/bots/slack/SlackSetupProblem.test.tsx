// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotHostOutage } from '../use-bot-host-outage'
import type { BotSlackSetupStep } from './slack-setup-step'
import {
  SlackSetupProblemStep,
  slackSetupProblem,
  useResumeWhenHostReturns
} from './SlackSetupProblem'

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

const reconnecting: BotHostOutage = {
  kind: 'reconnecting',
  environmentId: 'build-box',
  reconnectable: true
}
const offline: BotHostOutage = { kind: 'offline', environmentId: 'build-box', reconnectable: true }

function show(step: BotSlackSetupStep, outage: BotHostOutage | null = null, paired = false) {
  const problem = slackSetupProblem(step, outage)
  if (!problem) {
    throw new Error(`no problem for ${JSON.stringify(step)}`)
  }
  const onNewLink = vi.fn()
  const onReplaceToken = vi.fn()
  const onOpenNewLink = vi.fn()
  act(() =>
    root.render(
      <SlackSetupProblemStep
        problem={problem}
        botName="Release Helper"
        hostName="build-box"
        onClose={() => {}}
        onNewLink={onNewLink}
        onOpenNewLink={paired ? onOpenNewLink : undefined}
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
    onOpenNewLink,
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

  it('says Slack sign-in didn’t finish and gets a new link', () => {
    const view = show({ kind: 'expired', teamId: 'T1' })
    expect(view.text).toContain('Slack sign-in didn’t finish.')
    expect(view.text).toContain('The Slack link expired before anyone approved the connection.')
    expect(view.text).not.toMatch(/callback/)
    expect(view.details?.getAttribute('aria-expanded')).toBe('false')
    view.click('Get a new link')
    expect(view.onNewLink).toHaveBeenCalledWith('T1')
  })

  it('opens a new link on the bot’s computer from the expired step', () => {
    const view = show({ kind: 'expired', teamId: 'T1' }, null, true)
    expect(view.buttons).toEqual(['Details', 'Close', 'Get a new link', 'Open Slack on build-box'])
    view.click('Open Slack on build-box')
    expect(view.onOpenNewLink).toHaveBeenCalledWith('T1')
    expect(view.onNewLink).not.toHaveBeenCalled()
  })

  it('sends a rejected token to the token step for its workspace, not Try again', () => {
    const view = show({ kind: 'failed', code: 'grant_expired', teamId: 'T1' })
    expect(view.text).toContain('Slack rejected this workspace’s token.')
    expect(view.buttons).not.toContain('Try again')
    view.click('Replace token')
    expect(view.onReplaceToken).toHaveBeenCalledWith('T1', false)
  })

  it('keeps a token this desktop handed over on this desktop when Slack rejects it', () => {
    const view = show({ kind: 'failed', code: 'grant_expired', teamId: 'T1', local: true })
    view.click('Replace token')
    expect(view.onReplaceToken).toHaveBeenCalledWith('T1', true)
  })

  it('keeps Details collapsed until opened, and keeps codes out of the main text', () => {
    const view = show({ kind: 'failed', code: 'grant_expired', teamId: 'T1' })
    expect(view.details?.getAttribute('aria-expanded')).toBe('false')
    expect(view.panel?.hidden).toBe(true)
    const mainText = view.text.replace(view.panel?.textContent ?? '', '')
    expect(mainText).not.toMatch(/grant_expired|code:|callback/)
    act(() => view.details!.click())
    expect(view.panel?.hidden).toBe(false)
    expect(view.panel?.textContent).toContain('computer: build-box')
  })

  it('leaves other failures, and this computer’s own sign-in, to the existing one-line message', () => {
    expect(slackSetupProblem({ kind: 'failed', code: 'cloud_unreachable' }, null)).toBeNull()
    // Any refusal from Slack, not only the token's: its own words, not Replace token.
    expect(
      slackSetupProblem({ kind: 'failed', code: 'slack_refused', teamId: 'T1' }, null)
    ).toBeNull()
    expect(slackSetupProblem({ kind: 'failed', code: 'cloud_error' }, null)).toBeNull()
    expect(
      slackSetupProblem({ kind: 'failed', code: 'signed_out', local: true }, reconnecting)
    ).toBeNull()
  })
})

describe('resuming Slack setup once the server is back', () => {
  function Probe(props: {
    step: BotSlackSetupStep
    outage: BotHostOutage | null
    retry: (teamId?: string, handOff?: boolean) => Promise<void>
  }) {
    useResumeWhenHostReturns(props.step, props.outage, props.retry)
    return null
  }
  function harness() {
    const retry = vi.fn(async (_teamId?: string, _handOff?: boolean) => {})
    const at = (step: BotSlackSetupStep, outage: BotHostOutage | null) =>
      act(() => root.render(<Probe step={step} outage={outage} retry={retry} />))
    return { retry, at }
  }
  const stopped: BotHostOutage = { ...offline, reconnectable: false }
  const failed: BotSlackSetupStep = { kind: 'failed', code: 'cloud_error', teamId: 'T1' }

  it('checks the failed workspace again once, after the server answers', () => {
    const { retry, at } = harness()
    at(failed, reconnecting)
    expect(retry).not.toHaveBeenCalled()
    at(failed, null)
    at(failed, null)
    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith('T1', undefined)
  })

  it('resumes a hand-off as a hand-off', () => {
    const { retry, at } = harness()
    const handOff: BotSlackSetupStep = { ...failed, handOff: true }
    at(handOff, reconnecting)
    at(handOff, null)
    expect(retry).toHaveBeenCalledWith('T1', true)
  })

  it('resumes a request the server dropped and answered again before it failed', () => {
    const { retry, at } = harness()
    at({ kind: 'setting-up' }, reconnecting)
    at({ kind: 'setting-up' }, null)
    at(failed, null)
    expect(retry).toHaveBeenCalledWith('T1', undefined)
  })

  it('waits through an outage Reconnect cannot end, until the server answers', () => {
    const { retry, at } = harness()
    at(failed, reconnecting)
    at(failed, stopped)
    expect(retry).not.toHaveBeenCalled()
    at(failed, null)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('does not repeat a failure the outage did not cause', () => {
    const { retry, at } = harness()
    at({ kind: 'setting-up' }, reconnecting)
    at({ kind: 'setting-up' }, null)
    at({ kind: 'failed', code: 'rate_limited', teamId: 'T1' }, null)
    const ownSignIn: BotSlackSetupStep = {
      kind: 'failed',
      code: 'signed_out',
      teamId: 'T1',
      local: true
    }
    at(ownSignIn, reconnecting)
    at(ownSignIn, null)
    expect(retry).not.toHaveBeenCalled()
  })

  it('leaves a failure shown before the outage alone, but resumes one that arrives during it', () => {
    const { retry, at } = harness()
    const earlier: BotSlackSetupStep = { kind: 'failed', code: 'cloud_error', teamId: 'T1' }
    at(earlier, null)
    at(earlier, reconnecting)
    at(earlier, null)
    expect(retry).not.toHaveBeenCalled()
    const during: BotSlackSetupStep = { kind: 'failed', code: 'cloud_error', teamId: 'T1' }
    at(during, reconnecting)
    at(during, null)
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('settles when the shown step is rebuilt on every render', () => {
    // The setup hook derives installed, other-user and expired afresh each render.
    function Rebuilt(props: { kind: 'installed' | 'other-user' | 'expired' }) {
      useResumeWhenHostReturns({ kind: props.kind, teamId: 'T1' }, null, async () => {})
      return null
    }
    for (const kind of ['installed', 'other-user', 'expired'] as const) {
      expect(() => act(() => root.render(<Rebuilt kind={kind} />))).not.toThrow()
    }
  })

  it('arms nothing for an outage during an idle step', () => {
    const { retry, at } = harness()
    at({ kind: 'pick', teamIds: ['T1'] }, reconnecting)
    at({ kind: 'pick', teamIds: ['T1'] }, null)
    at(failed, null)
    expect(retry).not.toHaveBeenCalled()
  })

  it('never shows the waiting screen for a failure it will not resume', () => {
    // Slack's own refusal while the server happens to be down keeps its own words.
    expect(
      slackSetupProblem({ kind: 'failed', code: 'rate_limited', teamId: 'T1' }, reconnecting)
    ).toBeNull()
  })
})
