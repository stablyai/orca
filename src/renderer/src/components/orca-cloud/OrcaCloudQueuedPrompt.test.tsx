// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OrcaCloudQueuedPromptView } from './OrcaCloudQueuedPrompt'

afterEach(() => {
  cleanup()
})

function heading(props: { held?: boolean; editable: boolean; draft?: boolean }): string {
  const { container } = render(
    <OrcaCloudQueuedPromptView
      agentName="Claude"
      prompt="Fix the typo"
      onQueue={() => {}}
      {...props}
    />
  )
  return container.querySelector('[data-orca-cloud-queued-prompt="queued"] p')?.textContent ?? ''
}

describe('OrcaCloudQueuedPromptView heading (DS-e)', () => {
  it('says the first prompt sends when the workspace is ready', () => {
    expect(heading({ editable: true })).toBe(
      'First prompt for Claude · Sends when the workspace is ready'
    )
  })

  it('says it waits for the agent while the agent isn’t set up (PC-3b hold)', () => {
    expect(heading({ editable: true, held: true })).toBe(
      'First prompt for Claude · Sends once Claude is set up'
    )
    // Past provisioning it still waits: never "Sending to Claude next" while held.
    expect(heading({ editable: false, held: true })).toBe(
      'First prompt for Claude · Sends once Claude is set up'
    )
  })

  it('keeps the draft and hand-off wording', () => {
    expect(heading({ editable: true, draft: true })).toBe('Draft for Claude, typed in when ready')
    expect(heading({ editable: false })).toBe('Sending to Claude next')
  })
})
