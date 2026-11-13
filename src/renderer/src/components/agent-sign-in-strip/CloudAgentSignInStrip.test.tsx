// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CloudAgentSignInStrip, type CloudStripActions } from './CloudAgentSignInStrip'
import { stripPrimaryLink } from './CloudStripPrimaryButton'
import type { CloudStripModel } from './cloud-agent-strip-model'

afterEach(() => cleanup())

const noop = (): void => {}
const actions: CloudStripActions = {
  primary: noop,
  submitCode: noop,
  pasteCode: noop,
  useCode: noop,
  useApiKey: noop,
  cancel: noop
}
const model: CloudStripModel = {
  status: 'warning',
  title: 'A title long enough that a narrow pane would cut it off',
  detail: 'A detail sentence that also runs past the width of a narrow pane',
  description: null,
  primary: { label: 'Restart', action: { kind: 'restart' } },
  code: null,
  paste: null,
  otherWays: false,
  announcement: 'A title'
}

function strip(): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      <CloudAgentSignInStrip model={model} prompt={null} actions={actions} width="compact" />
    </TooltipProvider>
  )
  return container.querySelector<HTMLElement>('[data-cloud-sign-in-strip]')!
}

describe('CloudAgentSignInStrip wrap', () => {
  it('never truncates: the strip grows and title and detail wrap up to 3 lines, even when narrow', () => {
    const element = strip()
    expect(element.className).toContain('min-h-14')
    expect(element.className).not.toMatch(/(^|\s)h-14(\s|$)/)
    const [title, detail] = element.querySelectorAll('[data-strip-text] > span')
    for (const text of [title, detail]) {
      expect(text?.className).toContain('line-clamp-3')
      expect(text?.className).not.toContain('truncate')
      expect(text?.className).not.toContain('sr-only')
    }
    expect(title?.textContent).toBe(model.title)
  })
})

describe('CloudAgentSignInStrip Copy link', () => {
  const deviceUrl = 'https://auth.openai.com/codex/device'
  const device: CloudStripModel = {
    ...model,
    status: 'need',
    title: 'Enter this code on auth.openai.com',
    detail: 'Only continue if you started this sign-in in Orca.',
    primary: {
      label: 'Copy code and open',
      action: { kind: 'copyAndOpen', url: deviceUrl, code: 'EY7X-YDTV6' }
    },
    code: 'EY7X-YDTV6'
  }
  const renderStrip = (m: CloudStripModel): HTMLElement =>
    render(
      <TooltipProvider>
        <CloudAgentSignInStrip model={m} prompt={null} actions={actions} width="wide" />
      </TooltipProvider>
    ).container

  it('gives a primary that opens a page the Copy link chevron', () => {
    expect(renderStrip(device).querySelector('[data-open-external-chevron]')).not.toBeNull()
  })

  it('keeps a primary that opens nothing a plain button', () => {
    expect(renderStrip(model).querySelector('[data-open-external-chevron]')).toBeNull()
  })

  it('copies the verification URL, a lazy setup link, or nothing', () => {
    expect(stripPrimaryLink(device.primary!.action, {})).toBe(deviceUrl)
    expect(stripPrimaryLink({ kind: 'openAgain', url: 'https://claude.ai/x' }, {})).toBe(
      'https://claude.ai/x'
    )
    expect(stripPrimaryLink({ kind: 'reopenSetup' }, {})).toBeNull()
    const lazy = async (): Promise<string> => 'https://claude.ai/setup'
    const linkFor = (action: { kind: string }) => (action.kind === 'reopenSetup' ? lazy : null)
    expect(stripPrimaryLink({ kind: 'reopenSetup' }, { linkFor })).toBe(lazy)
    expect(stripPrimaryLink({ kind: 'restart' }, {})).toBeNull()
  })
})
