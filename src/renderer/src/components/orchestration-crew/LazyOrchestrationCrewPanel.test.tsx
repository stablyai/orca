// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { LazyOrchestrationCrewPanel } from './LazyOrchestrationCrewPanel'

const load = vi.hoisted(() => ({ failures: 1 }))
vi.mock('./OrchestrationCrewPanel', () => ({
  get OrchestrationCrewPanel() {
    if (load.failures > 0) {
      load.failures--
      throw new Error('chunk failed')
    }
    return () => <div>Orchestration panel</div>
  }
}))

afterEach(() => cleanup())

const props: ComponentProps<typeof LazyOrchestrationCrewPanel> = {
  target: { kind: 'local' },
  party: 'term_coordinator'
}

it('leaves a failed load out quietly and loads again on the next mount', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const first = render(<LazyOrchestrationCrewPanel {...props} />)
  await vi.waitFor(() => expect(load.failures).toBe(0))
  expect(first.container).toBeEmptyDOMElement()
  first.unmount()

  // Turning the setting back on (or another pane) mounts again and gets a fresh attempt.
  render(<LazyOrchestrationCrewPanel {...props} />)
  expect(await screen.findByText('Orchestration panel')).toBeInTheDocument()
})
