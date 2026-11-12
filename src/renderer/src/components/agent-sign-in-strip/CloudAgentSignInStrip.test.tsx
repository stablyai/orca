// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { CloudAgentSignInStrip, type CloudStripActions } from './CloudAgentSignInStrip'
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
