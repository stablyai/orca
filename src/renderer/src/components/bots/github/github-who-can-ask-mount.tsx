// Test mount for Who can ask › Add on GitHub as the bot page draws it: the production service hook
// inside the real list (its grant path included). Test files mock the GitHub state, host calls and
// grant writer; every login, name and id here is synthetic.
import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type {
  BotGitHubRoster,
  ConnectorGitHubState,
  ConnectorGitHubUsersResponse
} from '../../../../../shared/connector-bot-github-contract'
import type { BotSlackResult } from '../../../../../shared/connector-bot-slack-contract'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host/execution-host'
import { TooltipProvider } from '@/components/ui/tooltip'
import { BotWhoCanAskList } from '../BotWhoCanAskList'
import { useGitHubWhoCanAsk } from './use-github-who-can-ask'

export type Users = BotSlackResult<ConnectorGitHubUsersResponse>
export type People = BotSlackResult<BotGitHubRoster>

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test bot with the fields the list reads.
export const bot = { id: 'bot-1', hostId: 'local', name: 'Atlas', members: [] } as unknown as Bot

type Account = { userId: string; login: string }
type Install = { installationId: string; accountLogin: string; repos: string[] | null }

/** The GitHub state the bot page reads: linked accounts and the app's installations. */
export function gitHubView(
  accounts: Account[] = [{ userId: '1', login: 'owner-one' }],
  installs: Install[] = [{ installationId: '11', accountLogin: 'acme', repos: ['acme/web'] }]
): { status: 'ready'; github: ConnectorGitHubState } {
  return {
    status: 'ready',
    github: {
      installUrl: 'https://github.com/apps/orca-test/installations/new',
      account: accounts[0] ?? null,
      accounts: accounts.map((account) => ({
        ...account,
        installations: installs.map((install) => install.installationId),
        defaultBotId: null
      })),
      installations: installs.map((install) => ({
        installationId: install.installationId,
        accountLogin: install.accountLogin,
        repositories: install.repos?.map((fullName) => ({ fullName })) ?? null
      })),
      defaultBotId: null
    }
  }
}

export function rosterOf(
  people: { id: string; login: string; name: string | null }[],
  from: { repositories: boolean; organizations: boolean } = {
    repositories: true,
    organizations: false
  }
): Extract<BotGitHubRoster, { status: 'read' }> {
  return {
    status: 'read',
    people,
    from,
    complete: true,
    omitted: false,
    cut: { people: false, members: false, repositories: false },
    readAt: new Date(2026, 10, 25, 9, 30).getTime(),
    reused: false,
    readFor: { scope: { repositories: ['acme/web'], owners: [], more: false }, owner: 'owner-one' }
  }
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T): void => {}
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/** The bot page's GitHub Who can ask, with the production service. */
export function HostedWhoCanAsk({ listed = bot }: { listed?: Bot }): React.JSX.Element {
  const service = useGitHubWhoCanAsk(LOCAL_EXECUTION_HOST_ID, true)
  return (
    <TooltipProvider>
      <BotWhoCanAskList bot={listed} service={service} compactCaption="People with access" />
    </TooltipProvider>
  )
}

export function mountWhoCanAsk(): void {
  render(<HostedWhoCanAsk />)
  fireEvent.click(screen.getByRole('button', { name: 'Add people' }))
}

export const searchBox = (): HTMLElement =>
  screen.getByPlaceholderText('Search by name or username')

/** Types into the picker and lets its debounce fire. */
export async function typeQuery(value: string, wait = 300): Promise<void> {
  fireEvent.change(searchBox(), { target: { value } })
  await act(() => vi.advanceTimersByTimeAsync(wait))
}

export async function settle(ms = 0): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

/** The picker's option rows, as their text. */
export const optionTexts = (): string[] =>
  screen.queryAllByRole('option').map((option) => option.textContent ?? '')

/** The rows under one heading, as their text. */
export function groupTexts(heading: string): string[] {
  const group = screen.queryByText(heading)?.closest('[cmdk-group]')
  return group ? [...group.querySelectorAll('[cmdk-item]')].map((row) => row.textContent ?? '') : []
}

/** Counts every "Searching…" paint from now until stop(). */
export function watchSearching(): { stop: () => number } {
  let seen = 0
  const observer = new MutationObserver(() => {
    if (screen.queryByText('Searching…')) {
      seen += 1
    }
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  return {
    stop: () => {
      observer.disconnect()
      return seen
    }
  }
}
