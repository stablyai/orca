// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GoogleSetupRun } from '../../../../../../shared/google/google-setup-run'
import type { GoogleSetupCardRef } from '../../../../../../shared/google/google-setup-card'
import type { KeySource } from '../use-capture-google-key'
import type { GoogleSetupBlocker } from '../../../../../../shared/google/google-setup-blocker'

const mocks = vi.hoisted(() => {
  const run: { current: GoogleSetupRun | null } = { current: null }
  const host: { current: object } = { current: { status: 'loading' } }
  const sources: KeySource[][] = [[]]
  const blocker: { current: GoogleSetupBlocker | null } = { current: null }
  const signInState: { current: object } = { current: { kind: 'idle' } }
  return {
    run,
    host,
    sources,
    blocker,
    pick: vi.fn(),
    open: vi.fn(),
    refresh: vi.fn(),
    signInState,
    answer: vi.fn(),
    connect: vi.fn(),
    turnOn: vi.fn(),
    share: vi.fn()
  }
})
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => [{ hostId: 'local', id: 'ivy', name: 'Ivy' }]
}))
vi.mock('./google-setup-run-store', () => ({
  useGoogleSetupRun: () => mocks.run.current,
  useGoogleSetupBlocker: () => mocks.blocker.current,
  answerGoogleSetup: mocks.answer
}))
vi.mock('../use-capture-google-key', () => ({
  useCaptureClientKey: (source: KeySource) => {
    mocks.sources[0].push(source)
    return { error: null, gaveUp: false }
  }
}))
vi.mock('../use-google-sign-in', () => ({
  useGoogleSignIn: () => ({
    state: mocks.signInState.current,
    connect: mocks.connect,
    cancel: vi.fn()
  })
}))
vi.mock('../use-turn-on-bot-google', () => ({ useTurnOnBotGoogle: () => mocks.turnOn }))
vi.mock('../google-connect-client', () => ({
  useGoogleHost: () => mocks.host.current,
  importGoogleApp: vi.fn(),
  openInMyBrowser: mocks.open,
  refreshGoogle: mocks.refresh,
  shareGoogleApp: mocks.share
}))
vi.mock('../use-google-client-file', () => ({
  useGoogleClientFile: () => ({ busy: false, error: null, pick: mocks.pick, submit: vi.fn() })
}))

import { TooltipProvider } from '@/components/ui/tooltip'
import { GoogleSetupChatCard } from './GoogleSetupChatCard'

function run(overrides: Partial<GoogleSetupRun> = {}): GoogleSetupRun {
  return {
    id: 'run-1',
    botId: 'ivy',
    state: 'running',
    mode: 'do-it-for-me',
    steps: {},
    answers: {},
    startedAt: 1,
    updatedAt: 1,
    revision: 1,
    ...overrides
  }
}

function show(card: GoogleSetupCardRef['card'], step?: GoogleSetupCardRef['step']) {
  const ref: GoogleSetupCardRef = { botId: 'ivy', runId: 'run-1', card, ...(step ? { step } : {}) }
  return render(<GoogleSetupChatCard card={ref} fallback="Fallback line" />)
}

beforeEach(() => {
  mocks.run.current = run()
  mocks.host.current = { status: 'loading' }
  mocks.sources[0] = []
  mocks.answer.mockReset().mockResolvedValue(undefined)
  mocks.blocker.current = null
  mocks.pick.mockReset()
  mocks.open.mockReset()
  mocks.refresh.mockReset().mockResolvedValue({ status: 'ready', google: {} })
  mocks.signInState.current = { kind: 'idle' }
  mocks.connect.mockReset()
  mocks.turnOn.mockReset()
})
afterEach(cleanup)

describe('a Google setup card in the chat', () => {
  it('shows the host line until the run is read, and says an earlier run ended', () => {
    mocks.run.current = null
    show('path')
    expect(screen.getByText('Fallback line')).toBeTruthy()
    cleanup()
    mocks.run.current = run({ id: 'run-2' })
    show('path')
    expect(screen.getByText('This Google setup ended.')).toBeTruthy()
  })

  it('shows a path receipt and offers changes until the project is done', async () => {
    show('path')
    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Do it for me'),
        expect.stringContaining('Guide me here'),
        expect.stringContaining('Guide me in my browser')
      ])
    )
    fireEvent.click(screen.getByRole('button', { name: /Guide me here/ }))
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'path', [
        'guide-here'
      ])
    )
    cleanup()
    mocks.run.current = run({
      mode: 'guide-here',
      answers: { path: { values: ['guide-here'], at: 2 } }
    })
    show('path')
    expect(screen.getByText('✓ You chose Guide me here')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: /Guide me in my browser/ }).hasAttribute('disabled')
    ).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect(
      screen.getByRole('button', { name: /Guide me in my browser/ }).hasAttribute('disabled')
    ).toBe(false)

    cleanup()
    mocks.run.current = run({
      mode: 'guide-here',
      answers: { path: { values: ['guide-here'], at: 2 } },
      steps: { project: { status: 'done', at: 3, by: 'bot' } }
    })
    show('path')
    expect(screen.getByText('✓ You chose Guide me here')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
  })

  it('says Dismiss through the card', async () => {
    show('path')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'path', [
        'not-now'
      ])
    )
  })

  it('picks one of the signed-in accounts the run offers', async () => {
    mocks.run.current = run({ accounts: ['a@x.com', 'b@x.com'] })
    show('account')
    fireEvent.click(screen.getByRole('button', { name: /b@x\.com/ }))
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'account', [
        'b@x.com'
      ])
    )
  })

  it('sends the services picked, and locks to them', async () => {
    show('services')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ivy' }),
        'services',
        ['gmail']
      )
    )
    cleanup()
    mocks.run.current = run({ answers: { services: { values: ['gmail', 'calendar'], at: 2 } } })
    show('services')
    expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull()
    expect(screen.getByText(/✓ You chose Gmail/)).toBeTruthy()
  })

  it('lets the person take a step the bot is on', async () => {
    mocks.run.current = run({ steps: { account: { status: 'done', at: 2, by: 'bot' } } })
    show('progress')
    expect(screen.getByText('Working')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Let me do this one' }))
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'step', [
        'let-me',
        'project'
      ])
    )
  })

  it("waits for the app key in Downloads on one progress card only, for the person's own browser", () => {
    const at = { status: 'done' as const, at: 2, by: 'bot' as const }
    mocks.run.current = run({
      mode: 'guide-browser',
      steps: { account: at, project: at, apis: at, branding: at, links: at, publish: at },
      cardCopies: { progress: 1 }
    })
    render(
      <>
        <GoogleSetupChatCard
          card={{ botId: 'ivy', runId: 'run-1', card: 'progress' }}
          fallback=""
        />
        <GoogleSetupChatCard
          card={{ botId: 'ivy', runId: 'run-1', card: 'progress', copy: 1 }}
          fallback=""
        />
      </>
    )
    // Each render reports its source; the last of each pair is what the cards settled on.
    const settled = mocks.sources[0].slice(-2)
    expect(settled).toEqual([null, { kind: 'downloads' }])
  })

  it('takes Done and Take over from a step card, and shows a receipt after', async () => {
    mocks.run.current = run({
      mode: 'guide-here',
      steps: { apis: { status: 'active', at: 2 } }
    })
    show('step', 'apis')
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'step', [
        'done',
        'apis'
      ])
    )
    fireEvent.click(screen.getByRole('button', { name: 'Take over from here' }))
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'step', [
        'take-over',
        'apis'
      ])
    )
    cleanup()
    mocks.run.current = run({ steps: { apis: { status: 'active', at: 2 } } })
    show('step', 'apis')
    expect(screen.getByText('✓ Ivy takes over from here')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(true)
  })

  it('shows the three links on the links step only, and no Take over on the policy box', () => {
    const step = (name: 'branding' | 'links') => {
      mocks.run.current = run({
        mode: 'guide-here',
        kind: 'personal',
        steps: { [name]: { status: 'active', at: 2 } }
      })
      render(
        <TooltipProvider>
          <GoogleSetupChatCard
            card={{ botId: 'ivy', runId: 'run-1', card: 'step', step: name }}
            fallback=""
          />
        </TooltipProvider>
      )
    }
    step('branding')
    expect(screen.queryByText('Application privacy policy link')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Take over from here' })).toBeNull()
    cleanup()
    step('links')
    expect(screen.getByText('Application privacy policy link')).toBeTruthy()
  })

  it('waits for the key even while an earlier step is still open, with Import as a fallback', () => {
    const at = { status: 'done' as const, at: 2, by: 'bot' as const }
    mocks.run.current = run({
      mode: 'guide-browser',
      steps: {
        account: at,
        project: at,
        apis: at,
        branding: { status: 'needs-user', at: 3, note: 'Tick the box' },
        client: { status: 'active', at: 4 }
      }
    })
    show('progress')
    expect(mocks.sources[0].at(-1)).toEqual({ kind: 'downloads' })
    fireEvent.click(screen.getByRole('button', { name: 'Import file' }))
    expect(mocks.pick).toHaveBeenCalled()
  })

  it('offers Make a new key on the progress card when the key went missing before client is done', async () => {
    mocks.run.current = run({
      steps: { client: { status: 'active', at: 2 } },
      keyMissed: { at: 3, reason: 'This is a Web app client.' }
    })
    mocks.blocker.current = {
      kind: 'no-key',
      actions: [{ id: 'make-new-key' }, { id: 'import-key' }]
    }
    show('progress')
    expect(screen.queryByRole('button', { name: 'Import file' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Make a new key' }))
    })
    expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'step', [
      'redo',
      'client'
    ])
  })

  it('keeps sign-in and recovery actions on the newest Connect Google card', () => {
    mocks.run.current = run({
      account: 'a@x.com',
      steps: { client: { status: 'done', at: 2 } },
      cardCopies: { connect: 1 }
    })
    const older = { botId: 'ivy', runId: 'run-1', card: 'connect' as const }
    const newer = { ...older, copy: 1 }
    // The bottom copy mounts first; scrolling up then mounts the older one above it.
    const { rerender } = render(
      <div>
        <GoogleSetupChatCard key="newer" card={newer} fallback="" />
      </div>
    )
    const bothCopies = () => (
      <div>
        <GoogleSetupChatCard key="older" card={older} fallback="" />
        <GoogleSetupChatCard key="newer" card={newer} fallback="" />
      </div>
    )
    rerender(bothCopies())
    expect(screen.getAllByRole('button', { name: 'Sign in to Google' })).toHaveLength(1)
    expect(screen.getAllByText('Continued further down.')).toHaveLength(1)
    expect(
      screen
        .getByRole('button', { name: 'Sign in to Google' })
        .compareDocumentPosition(screen.getByText('Continued further down.')) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy()
    mocks.run.current = run({
      account: 'a@x.com',
      services: ['gmail', 'calendar'],
      steps: { client: { status: 'done', at: 2 }, connect: { status: 'done', at: 3 } },
      cardCopies: { connect: 1 }
    })
    mocks.blocker.current = {
      kind: 'needs-permission',
      services: ['calendar'],
      actions: [
        { id: 'allow', services: ['calendar'] },
        { id: 'continue-without', services: ['calendar'] }
      ]
    }
    rerender(bothCopies())
    // Both the primary and the secondary recovery button show once, on the newest copy.
    expect(screen.getAllByRole('button', { name: 'Allow Calendar' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Continue without them' })).toHaveLength(1)
    expect(screen.getAllByText('Continued further down.')).toHaveLength(1)
    expect(
      screen
        .getByRole('button', { name: 'Allow Calendar' })
        .compareDocumentPosition(screen.getByText('Continued further down.')) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy()
  })

  it('lets only the newest copy of a waiting step card act', () => {
    mocks.run.current = run({
      mode: 'do-it-for-me',
      steps: { branding: { status: 'needs-user', at: 2, note: 'Tick the box' } },
      cardCopies: { 'step:branding': 1 }
    })
    const older = { botId: 'ivy', runId: 'run-1', card: 'step' as const, step: 'branding' as const }
    render(
      <TooltipProvider>
        <GoogleSetupChatCard card={older} fallback="" />
        <GoogleSetupChatCard card={{ ...older, copy: 1 }} fallback="" />
      </TooltipProvider>
    )
    const enabled = screen
      .getAllByRole('button', { name: 'Done' })
      .filter((button) => !button.hasAttribute('disabled'))
    expect(enabled).toHaveLength(1)
  })

  it('wakes the bot after Allow, so it runs done again', async () => {
    mocks.run.current = run({
      account: 'a@x.com',
      services: ['gmail', 'calendar'],
      steps: { client: { status: 'done', at: 2 }, connect: { status: 'done', at: 3 } }
    })
    mocks.blocker.current = {
      kind: 'needs-permission',
      services: ['calendar'],
      actions: [
        { id: 'allow', services: ['calendar'] },
        { id: 'continue-without', services: ['calendar'] }
      ]
    }
    mocks.connect.mockResolvedValue({ email: 'a@x.com' })
    show('connect')
    expect(screen.getByText(/Almost there: allow Calendar/)).toBeTruthy()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Allow Calendar' }))
    })
    expect(mocks.connect).toHaveBeenCalledWith(['calendar'], 'a@x.com')
    expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'step', [
      'resume'
    ])
  })

  it('signs the owner in, then tells the bot whether Google is on for it', async () => {
    mocks.run.current = run({ account: 'a@x.com', services: ['gmail'] })
    mocks.connect.mockResolvedValue({ email: 'a@x.com' })
    mocks.turnOn.mockResolvedValue(false)
    show('connect')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in to Google' }))
    })
    expect(mocks.connect).toHaveBeenCalledWith(['gmail'], 'a@x.com')
    expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'step', [
      'done',
      'connect',
      'google-off'
    ])
  })

  it('says what the bot can use, with share only for a work app', () => {
    mocks.host.current = {
      status: 'ready',
      google: {
        client: { clientId: 'c', projectId: 'p' },
        accounts: [
          {
            email: 'a@x.com',
            status: 'connected',
            connectedAt: 1,
            services: [{ service: 'gmail', state: 'ready' }]
          }
        ],
        bots: []
      }
    }
    mocks.run.current = run({ state: 'done', account: 'a@x.com', kind: 'work' })
    show('connected')
    expect(screen.getByText('Ivy can use Gmail.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Share setup' }))
    expect(mocks.share).toHaveBeenCalledWith({ kind: 'local' }, 'p')
    cleanup()
    mocks.run.current = run({ state: 'done', account: 'a@x.com', kind: 'personal' })
    show('connected')
    expect(screen.queryByRole('button', { name: 'Share setup' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add a service' })).toBeTruthy()
  })

  it('keeps a step handed to the person theirs, even while the bot does the rest', () => {
    mocks.run.current = run({
      steps: {
        account: { status: 'done', at: 2, by: 'bot' },
        project: { status: 'needs-user', at: 3, note: 'Tick the box' }
      }
    })
    show('step', 'project')
    expect(screen.getByRole('button', { name: 'Done' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/takes over from here/)).toBeNull()
    cleanup()
    show('progress')
    expect(screen.getByText('Waiting for you')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Let me do this one' })).toBeNull()
  })

  it('leaves the sign-in to its own card', () => {
    const at = { status: 'done' as const, at: 2, by: 'bot' as const }
    mocks.run.current = run({
      steps: {
        account: at,
        project: at,
        apis: at,
        branding: at,
        links: at,
        publish: at,
        client: at
      }
    })
    show('progress')
    expect(screen.getByText('Waiting for you')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Let me do this one' })).toBeNull()
  })

  it("offers a different account while only one is signed in and the bot hasn't started", async () => {
    mocks.run.current = run({
      account: 'a@x.com',
      steps: { account: { status: 'done', at: 2, by: 'bot', note: 'Already signed in as a@x.com' } }
    })
    show('progress')
    fireEvent.click(screen.getByRole('button', { name: 'Switch account' }))
    await waitFor(() =>
      expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'account', [
        'other'
      ])
    )
    cleanup()
    mocks.run.current = run({
      account: 'a@x.com',
      steps: {
        account: { status: 'done', at: 2, by: 'bot' },
        project: { status: 'active', at: 3 }
      }
    })
    show('progress')
    expect(screen.queryByRole('button', { name: 'Switch account' })).toBeNull()
  })

  describe('getting unstuck', () => {
    const signedIn = (blocker: GoogleSetupBlocker, overrides: Partial<GoogleSetupRun> = {}) => {
      mocks.run.current = run({
        account: 'a@x.com',
        services: ['gmail', 'calendar'],
        steps: { client: { status: 'done', at: 2 }, connect: { status: 'done', at: 3 } },
        ...overrides
      })
      mocks.blocker.current = blocker
      show('connect')
    }

    it('opens the imported app project and only wakes the bot after a successful check', async () => {
      mocks.host.current = {
        status: 'ready',
        google: {
          client: { clientId: 'c', projectId: 'team-app' },
          accounts: [{ email: 'a@x.com', status: 'connected', services: [], connectedAt: 1 }],
          bots: []
        }
      }
      signedIn(
        {
          kind: 'api-off',
          services: ['calendar'],
          actions: [{ id: 'turn-on', services: ['calendar'] }, { id: 'check-again' }]
        },
        { account: undefined }
      )
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))
      })
      const url = new URL(String(mocks.open.mock.calls[0]?.[0]))
      expect(url.searchParams.get('project')).toBe('team-app')
      expect(url.searchParams.get('authuser')).toBe('a@x.com')

      mocks.refresh.mockResolvedValueOnce({ status: 'failed', error: 'offline' })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
      })
      expect(mocks.answer).not.toHaveBeenCalled()

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
      })
      expect(mocks.refresh).toHaveBeenCalledWith({ kind: 'local' }, { check: true })
      expect(mocks.answer).toHaveBeenCalledWith(expect.objectContaining({ id: 'ivy' }), 'step', [
        'resume'
      ])
    })

    it('goes on without the services that weren’t allowed', async () => {
      signedIn({
        kind: 'needs-permission',
        services: ['calendar'],
        actions: [
          { id: 'allow', services: ['calendar'] },
          { id: 'continue-without', services: ['calendar'] }
        ]
      })
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Continue without them' }))
      })
      expect(mocks.answer).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ivy' }),
        'services',
        ['gmail']
      )
    })

    it('says why a sign-in from the card failed, beside the same buttons', () => {
      mocks.signInState.current = { kind: 'failed', error: 'The sign-in timed out.' }
      signedIn({
        kind: 'signed-out',
        email: 'a@x.com',
        actions: [{ id: 'sign-in-again', email: 'a@x.com' }]
      })
      expect(screen.getByRole('alert').textContent).toBe('The sign-in timed out.')
      expect(screen.getByRole('button', { name: 'Sign in as a@x.com' })).toBeTruthy()
    })
  })
})
