// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZcodeCliSetupSection } from './ZcodeCliSetupSection'

const mocks = vi.hoisted(() => ({ settings: { agentCmdOverrides: { zcode: '' } } }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(mocks)
}))
vi.mock('../onboarding/OnboardingInlineCommandTerminal', () => ({
  OnboardingInlineCommandTerminal: ({
    command,
    description
  }: {
    command: string
    description: string
  }) => (
    <div data-testid="setup-terminal">
      <output>{command}</output>
      <p>{description}</p>
    </div>
  )
}))
vi.mock('./SearchableSetting', () => ({
  SearchableSetting: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

beforeEach(() => {
  mocks.settings.agentCmdOverrides.zcode = ''
})
afterEach(() => cleanup())

describe('ZCode CLI-owned sign-in setup', () => {
  it('starts no terminal until the user opens a supported flow', () => {
    render(<ZcodeCliSetupSection />)
    expect(screen.queryByTestId('setup-terminal')).not.toBeInTheDocument()
    expect(screen.getByText(/ZCode’s masked API-key setup/)).toBeInTheDocument()
    expect(screen.getByText(/use \/model to choose a GLM model/)).toBeInTheDocument()
  })

  it.each([
    ['Z.AI browser sign-in', 'zcode login zai --no-browser'],
    ['BigModel browser sign-in', 'zcode login bigmodel --no-browser'],
    ['ZCode API-key setup', 'zcode']
  ])('delegates %s to the supported upstream CLI command', async (label, command) => {
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(await screen.findByTestId('setup-terminal')).toHaveTextContent(command)
    expect(screen.getByRole('button', { name: 'Z.AI browser sign-in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'BigModel browser sign-in' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'ZCode API-key setup' })).toBeDisabled()
    if (label === 'ZCode API-key setup') {
      expect(screen.getByText(/enter \/login.*masked prompt/)).toBeInTheDocument()
    } else {
      expect(screen.getByText(/authorization URL printed by ZCode/)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Close setup terminal' }))
    expect(screen.queryByTestId('setup-terminal')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: label })).toBeEnabled()
  })

  it('preserves the configured CLI executable instead of inventing model flags', async () => {
    mocks.settings.agentCmdOverrides.zcode = 'node "C:\\ZCode CLI\\zcode.cjs"'
    render(<ZcodeCliSetupSection />)
    fireEvent.click(screen.getByRole('button', { name: 'BigModel browser sign-in' }))
    expect(await screen.findByTestId('setup-terminal')).toHaveTextContent(
      'node "C:\\ZCode CLI\\zcode.cjs" login bigmodel --no-browser'
    )
    expect(screen.getByTestId('setup-terminal')).not.toHaveTextContent('--model')
  })
})
