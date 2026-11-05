// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { emptyCrew, type OrchestrationCrewRow } from '../../../../shared/orchestration-crew'
import { OrchestrationCrewPanel } from './OrchestrationCrewPanel'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { i18n } from '@/i18n/i18n'

const rig = vi.hoisted(() => ({
  snapshot: {},
  open: vi.fn(),
  copy: vi.fn(),
  success: vi.fn(),
  mention: vi.fn()
}))
vi.mock('../native-chat/use-orchestration-crew', () => ({
  useOrchestrationCrew: () => rig.snapshot
}))
vi.mock('@/lib/open-agent-message-sender', () => ({ openOrchestrationCrewAgent: rig.open }))
vi.mock('sonner', () => ({ toast: { success: rig.success } }))
const host = { kind: 'environment', environmentId: 'captured-host' } as const
const worker: OrchestrationCrewRow = {
  partyKey: 'worker',
  role: 'worker',
  label: 'Worker',
  agentKind: 'codex',
  status: 'working',
  sendAddress: 'dispatch:d1',
  openTarget: { kind: 'terminal', handle: 'term_captured' },
  task: { title: 'Check the result', state: 'active' },
  latest: {
    direction: 'from',
    preview: 'The result is ready.',
    at: '2026-10-28T00:00:00Z',
    sequence: 1
  }
}

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  await i18n.changeLanguage('en')
})

it('keeps reverse-role disclosures independent and bounds them to the current source and complete relationships', async () => {
  const user = userEvent.setup()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const question = { preview: 'Which option?', at: '2026-10-28T01:00:00Z' }
    const manager = { ...worker, role: 'manager' as const, pendingQuestion: question }
    const reverseWorker = { ...worker, pendingQuestion: question }
    const peer = { ...worker, partyKey: 'other-worker', label: 'Other worker' }
    const relationships = {
      ...emptyCrew('ok'),
      sections: { managedBy: [manager], managing: [reverseWorker, peer], talkingWith: [] }
    }
    rig.snapshot = relationships
    const panel = (target: RuntimeClientTarget = host, party = 'term_coordinator') => (
      <TooltipProvider delayDuration={0}>
        <OrchestrationCrewPanel
          target={target}
          party={party}
          canMention={false}
          mention={rig.mention}
        />
      </TooltipProvider>
    )
    const view = render(panel())
    const tab = screen.getByRole('button', {
      name: 'Show orchestration: 2 workers, 1 needs you, 1 working'
    })
    expect(error).not.toHaveBeenCalled()
    expect(within(tab).getByText('2')).toBeInTheDocument()
    await user.click(tab)
    for (const name of ['Managed by', 'Managing']) {
      expect(
        within(screen.getByRole('region', { name })).getByRole('button', { name: 'Open Worker' })
      ).toBeInTheDocument()
    }
    const disclosure = (section: string) =>
      within(screen.getByRole('region', { name: section })).getByRole('button', {
        name: "Show Worker's task and latest message"
      })
    await user.click(disclosure('Managed by'))
    expect(disclosure('Managed by')).toHaveAttribute('aria-expanded', 'true')
    expect(disclosure('Managing')).toHaveAttribute('aria-expanded', 'false')
    await user.click(disclosure('Managing'))
    rig.snapshot = {
      ...relationships,
      sections: { ...relationships.sections, managing: [peer, reverseWorker] }
    }
    view.rerender(panel())
    expect(disclosure('Managed by')).toHaveAttribute('aria-expanded', 'true')
    expect(disclosure('Managing')).toHaveAttribute('aria-expanded', 'true')
    rig.snapshot = {
      ...relationships,
      sections: { ...relationships.sections, managedBy: [] }
    }
    view.rerender(panel())
    rig.snapshot = relationships
    view.rerender(panel())
    expect(disclosure('Managed by')).toHaveAttribute('aria-expanded', 'false')
    expect(disclosure('Managing')).toHaveAttribute('aria-expanded', 'true')
    rig.snapshot = emptyCrew('ok')
    view.rerender(panel())
    rig.snapshot = relationships
    view.rerender(panel())
    expect(disclosure('Managing')).toHaveAttribute('aria-expanded', 'false')
    for (const [target, party] of [
      [host, 'term_other'],
      [{ kind: 'environment', environmentId: 'other-host' }, 'term_other'],
      [{ kind: 'local' }, 'term_other']
    ] as const) {
      await user.click(disclosure('Managing'))
      expect(disclosure('Managing')).toHaveAttribute('aria-expanded', 'true')
      view.rerender(panel(target, party))
      expect(screen.getByRole('complementary', { name: 'Orchestration' })).toBeInTheDocument()
      expect(disclosure('Managing')).toHaveAttribute('aria-expanded', 'false')
    }
  } finally {
    error.mockRestore()
  }
})
