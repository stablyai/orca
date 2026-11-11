// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { setOrcaCloudAgentAccountsStateForTest } from '@/lib/orca-cloud/orca-cloud-agent-accounts-store'
import { OrcaCloudQueuedPrompt, OrcaCloudQueuedPromptView } from './OrcaCloudQueuedPrompt'

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

describe('OrcaCloudQueuedPromptView editing hint (N-04)', () => {
  function hint(held: boolean): string {
    const { container } = render(
      <OrcaCloudQueuedPromptView
        agentName="Claude"
        prompt=""
        editable
        held={held}
        onQueue={() => {}}
      />
    )
    const textarea = container.querySelector('textarea')
    const hintId = textarea?.getAttribute('aria-describedby') ?? ''
    return container.ownerDocument.getElementById(hintId)?.textContent ?? ''
  }

  it('waits for the workspace when the agent is set up', () => {
    expect(hint(false)).toBe('Claude starts with it as soon as the workspace is ready.')
  })

  it('waits for the agent from the first render while it isn’t set up', () => {
    expect(hint(true)).toBe('Sends once Claude is set up.')
  })
})

describe('OrcaCloudQueuedPrompt held copy from the first frame (N-04)', () => {
  it('reads the account state synchronously, so the first render already says it waits for setup', () => {
    setOrcaCloudAgentAccountsStateForTest({
      load: {
        kind: 'ready',
        status: {
          credentials: {
            claude: { state: 'none' },
            codex: { state: 'none' },
            providerEnabled: { claude: true, codex: true }
          },
          sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
        }
      },
      setups: { claude: { phase: 'idle' }, codex: { phase: 'idle' } },
      keyKinds: { claude: null, codex: null },
      queue: { agents: [], index: 0 }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the component reads only these fields
    const pending = {
      pendingWorktreeCreations: {
        c1: {
          status: 'creating',
          phase: 'provisioning-vm',
          request: {
            agent: 'claude',
            quickPrompt: '',
            creationStartup: { legacy: { command: 'claude' } },
            ephemeralVmRecipe: {
              sourceRepoId: 'repo',
              recipeId: 'cloud',
              projectId: 'project',
              provider: 'orca-cloud'
            }
          }
        }
      }
    } as unknown as Partial<ReturnType<typeof useAppStore.getState>>
    useAppStore.setState(pending)
    const { container } = render(<OrcaCloudQueuedPrompt creationId="c1" />)
    expect(
      container.querySelector('[data-orca-cloud-queued-prompt="editing"]')?.textContent
    ).toContain('Sends once Claude is set up.')
  })
})
