// @vitest-environment happy-dom
// Set up once → Escape: the "Set up once" button is replaced by the paste step, so focus must stay on
// the strip for Escape (which only listens inside it) to cancel the attempt. Also the refusal gap:
// the field and "Open again" stay in place, disabled, until the fresh link arrives.
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Translate } from '@/i18n/use-translate'
import { CloudAgentSignInStrip, type CloudStripActions } from './CloudAgentSignInStrip'
import { cloudAgentSetupStripModel } from './cloud-agent-setup-strip-model'
import type { OrcaCloudAgentSetup } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'

const t: Translate = (_key, fallback, options) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''))

function actions(): CloudStripActions & { cancel: ReturnType<typeof vi.fn> } {
  return {
    primary: vi.fn(),
    submitCode: vi.fn(),
    submitSetupCode: vi.fn(),
    useCode: vi.fn(),
    pasteCode: vi.fn(),
    useApiKey: vi.fn(),
    cancel: vi.fn()
  }
}

const strip = (setup: OrcaCloudAgentSetup, a: CloudStripActions) => (
  <TooltipProvider>
    <CloudAgentSignInStrip
      model={cloudAgentSetupStripModel({ agent: 'claude', setup, ready: false, t })}
      prompt={null}
      width="wide"
      actions={a}
    />
  </TooltipProvider>
)

afterEach(() => cleanup())

describe('the setup strip', () => {
  it('keeps focus when "Set up once" turns into the paste step, so Escape cancels the attempt', () => {
    const a = actions()
    const view = render(strip({ phase: 'idle' }, a))
    const setUp = screen.getByRole('button', { name: 'Set up once' })
    setUp.focus()
    view.rerender(strip({ phase: 'browser', startedAt: 0, canReopen: false }, a))
    const region = screen.getByRole('region')
    expect(region.contains(document.activeElement)).toBe(true)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(a.cancel).toHaveBeenCalledTimes(1)
  })

  it('in the gap after a refusal, the field and "Open again" stay, disabled', () => {
    const a = actions()
    render(strip({ phase: 'browser', startedAt: 0, canReopen: false, code: 'rejected' }, a))
    const field = screen.getByLabelText('Code from Claude’s sign-in page')
    expect(field).toHaveProperty('disabled', true)
    const openAgain = screen.getByRole('button', { name: 'Open again' })
    expect(openAgain.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(openAgain)
    expect(a.primary).not.toHaveBeenCalled()
    expect(
      screen.getByText('Paste the newest code from the sign-in page, or open it again.')
    ).toBeTruthy()
  })
})
