// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSessionProfile, WebAiAccount } from '../../../../shared/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import WebAiAccountRow from './WebAiAccountRow'

vi.mock('@/components/status-bar/icons', () => ({
  OpenAIIcon: () => <span data-testid="openai-icon" />,
  ClaudeIcon: () => <span data-testid="claude-icon" />,
  GeminiIcon: () => <span data-testid="gemini-icon" />
}))

afterEach(cleanup)

describe('WebAiAccountRow', () => {
  it('uses the Gemini provider icon for Gemini browser accounts', () => {
    const profile: BrowserSessionProfile = {
      id: 'profile-gemini',
      scope: 'isolated',
      partition: 'persist:profile-gemini',
      label: 'Gemini browser',
      source: null
    }
    const account: WebAiAccount = {
      id: 'account-gemini',
      provider: 'gemini',
      label: 'Personal Gemini',
      executionHostId: 'local',
      profileId: profile.id,
      sessionPartition: profile.partition,
      createdAt: 1
    }

    render(
      <TooltipProvider>
        <WebAiAccountRow
          account={account}
          profile={profile}
          profilesLoaded
          tabCount={0}
          active={false}
          onLaunch={vi.fn()}
          onManageProfiles={vi.fn()}
          onRemove={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByTestId('gemini-icon')).toBeInTheDocument()
    expect(screen.getByText('Gemini / Gemini browser')).toBeInTheDocument()
  })

  it('uses the Google icon and fixed label for Google AI Studio', () => {
    const profile: BrowserSessionProfile = {
      id: 'profile-aistudio',
      scope: 'isolated',
      partition: 'persist:profile-aistudio',
      label: 'AI Studio browser',
      source: null
    }
    const account: WebAiAccount = {
      id: 'account-aistudio',
      provider: 'aistudio',
      label: 'Work AI Studio',
      executionHostId: 'local',
      profileId: profile.id,
      sessionPartition: profile.partition,
      createdAt: 1
    }

    render(
      <TooltipProvider>
        <WebAiAccountRow
          account={account}
          profile={profile}
          profilesLoaded
          tabCount={0}
          active={false}
          onLaunch={vi.fn()}
          onManageProfiles={vi.fn()}
          onRemove={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByTestId('gemini-icon')).toBeInTheDocument()
    expect(screen.getByText('Google AI Studio / AI Studio browser')).toBeInTheDocument()
  })

  it('shows the account-owned service label for Custom providers', () => {
    const profile: BrowserSessionProfile = {
      id: 'profile-doubao',
      scope: 'isolated',
      partition: 'persist:profile-doubao',
      label: 'Doubao browser',
      source: null
    }
    const account: WebAiAccount = {
      id: 'account-doubao',
      provider: 'custom',
      label: 'Personal Doubao',
      executionHostId: 'local',
      profileId: profile.id,
      sessionPartition: profile.partition,
      customServiceLabel: 'Doubao',
      customHomeUrl: 'https://www.doubao.com/',
      customCookieDomains: ['doubao.com'],
      createdAt: 1
    }

    render(
      <TooltipProvider>
        <WebAiAccountRow
          account={account}
          profile={profile}
          profilesLoaded
          tabCount={0}
          active={false}
          onLaunch={vi.fn()}
          onManageProfiles={vi.fn()}
          onRemove={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByText('Doubao / Doubao browser')).toBeInTheDocument()
  })
})
