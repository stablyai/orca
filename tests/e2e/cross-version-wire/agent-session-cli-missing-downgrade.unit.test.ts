import { expect, test } from 'vitest'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// Pin a release predating cliMissing so unknown failure kinds must fall back to the host’s own sentence.
const BASELINE_REF = 'v1.4.218'

type OldStatusBlock = (body: Record<string, unknown>) => { text: string; failure?: unknown }

// Loads a real old build, including cold extraction and transforms.
test("an older client shows this host's sentence for a start whose CLI was not found", async () => {
  const words = agentSessionFailureWords(agentSessionFailureFact('cliMissing'), {
    agentName: 'Codex',
    surface: 'row'
  })
  expect(words).toEqual({
    text: "Codex wasn't found on the computer running this chat. Install it, or check its Command in Settings → Agents.",
    failure: { kind: 'cliMissing' }
  })

  const checkout = await materializeReleaseCheckout(BASELINE_REF)
  const [failure, statusBlock] = await Promise.all(
    [
      'src/shared/agent-session-failure.ts',
      'src/shared/structured-agent-session-status-block.ts'
    ].map((path) => importReleaseCheckoutModule(checkout, path))
  )
  const isKind = failure.isAgentSessionFailureKind
  const render = statusBlock.structuredAgentSessionStatusBlock
  if (typeof isKind !== 'function' || typeof render !== 'function') {
    throw new Error('the pinned release lacks the failure-kind reader or the status block')
  }
  expect(isKind('cliMissing')).toBe(false)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pinned release's export, checked to be a function above; a changed shape fails the assertions below.
  const block = (render as OldStatusBlock)({ kind: 'status', tone: 'error', ...words })
  expect(block.text).toBe(words.text)
  expect(block).not.toHaveProperty('failure')
}, 120_000)
