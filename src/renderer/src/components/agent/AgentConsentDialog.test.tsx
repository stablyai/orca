// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentConsentDecision, AgentConsentRecord } from '../../../../shared/agent-consent'
import { AgentConsentDialog, type AgentConsentDialogProps } from './AgentConsentDialog'

function successEnvelope(result: AgentConsentRecord): {
  id: string
  ok: true
  result: AgentConsentRecord
  _meta: { runtimeId: string }
} {
  return { id: 'test-request', ok: true, result, _meta: { runtimeId: 'test-runtime' } }
}

function failureEnvelope(message: string): {
  id: string
  ok: false
  error: { code: string; message: string }
  _meta: { runtimeId: string | null }
} {
  return {
    id: 'test-request',
    ok: false,
    error: { code: 'internal_error', message },
    _meta: { runtimeId: null }
  }
}

function recordFor(
  sourceAgentType: string,
  targetAgentType: string,
  decision: AgentConsentDecision
): AgentConsentRecord {
  return { sourceAgentType, targetAgentType, decision, decidedAt: 1700000000000 }
}

let runtimeCall: ReturnType<typeof vi.fn>

beforeEach(() => {
  runtimeCall = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { runtime: { call: runtimeCall } }
  })
})

afterEach(() => {
  document.body.innerHTML = ''
  Reflect.deleteProperty(window, 'api')
})

async function renderDialog(
  props: Partial<AgentConsentDialogProps> & {
    sourceAgentType: string
    targetAgentType: string
  }
): Promise<{ onOpenChange: ReturnType<typeof vi.fn>; onDecision: ReturnType<typeof vi.fn> }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onOpenChange = vi.fn()
  const onDecision = vi.fn()
  await act(async () => {
    root.render(
      <AgentConsentDialog
        open={props.open ?? true}
        sourceAgentType={props.sourceAgentType}
        targetAgentType={props.targetAgentType}
        onOpenChange={props.onOpenChange ?? onOpenChange}
        onDecision={props.onDecision ?? onDecision}
      />
    )
  })
  return { onOpenChange, onDecision }
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!button) {
    throw new Error(`missing "${label}" button`)
  }
  return button
}

async function clickButton(label: string): Promise<void> {
  const button = findButton(label)
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('AgentConsentDialog', () => {
  it('renders the source and target agent types being requested', async () => {
    runtimeCall.mockResolvedValue(successEnvelope(recordFor('codex', 'pi', 'allow')))
    await renderDialog({ sourceAgentType: 'codex', targetAgentType: 'pi' })

    expect(document.body.textContent).toContain('codex')
    expect(document.body.textContent).toContain('pi')
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'Allow'
      )
    ).toBe(true)
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (candidate) => candidate.textContent?.trim() === 'Deny'
      )
    ).toBe(true)
  })

  it('does not render dialog content while closed', async () => {
    await renderDialog({ sourceAgentType: 'codex', targetAgentType: 'pi', open: false })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('clicking Allow calls agent.consent.record with decision "allow" and reports the result', async () => {
    const record = recordFor('codex', 'pi', 'allow')
    runtimeCall.mockResolvedValue(successEnvelope(record))
    const { onOpenChange, onDecision } = await renderDialog({
      sourceAgentType: 'codex',
      targetAgentType: 'pi'
    })

    await clickButton('Allow')

    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'agent.consent.record',
      params: { sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'allow' }
    })
    expect(onDecision).toHaveBeenCalledWith('allow', record)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('clicking Deny calls agent.consent.record with decision "deny" and reports the result', async () => {
    const record = recordFor('codex', 'pi', 'deny')
    runtimeCall.mockResolvedValue(successEnvelope(record))
    const { onOpenChange, onDecision } = await renderDialog({
      sourceAgentType: 'codex',
      targetAgentType: 'pi'
    })

    await clickButton('Deny')

    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'agent.consent.record',
      params: { sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'deny' }
    })
    expect(onDecision).toHaveBeenCalledWith('deny', record)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('dismissing the dialog (e.g. Escape) records an explicit deny, same as PluginConsentDialog', async () => {
    const record = recordFor('codex', 'pi', 'deny')
    runtimeCall.mockResolvedValue(successEnvelope(record))
    const { onOpenChange, onDecision } = await renderDialog({
      sourceAgentType: 'codex',
      targetAgentType: 'pi'
    })

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'agent.consent.record',
      params: { sourceAgentType: 'codex', targetAgentType: 'pi', decision: 'deny' }
    })
    expect(onDecision).toHaveBeenCalledWith('deny', record)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('shows an error and stays open, without crashing, when the RPC call rejects', async () => {
    runtimeCall.mockRejectedValue(new Error('ECONNRESET: ipc channel closed'))
    const { onOpenChange, onDecision } = await renderDialog({
      sourceAgentType: 'codex',
      targetAgentType: 'pi'
    })

    await clickButton('Allow')

    expect(document.body.textContent).toContain('Could not save this decision. Try again.')
    expect(onDecision).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
    // Why: a failed decision must release the busy state so the user can retry.
    expect(findButton('Allow').disabled).toBe(false)
    expect(findButton('Deny').disabled).toBe(false)
  })

  it('shows the server-provided message when the RPC responds with a structured failure', async () => {
    runtimeCall.mockResolvedValue(
      failureEnvelope('messaging agent type "pi" was explicitly denied')
    )
    await renderDialog({ sourceAgentType: 'codex', targetAgentType: 'pi' })

    await clickButton('Deny')

    expect(document.body.textContent).toContain('messaging agent type "pi" was explicitly denied')
  })

  it('ignores a second click while a decision is in flight', async () => {
    let resolveCall: ((value: ReturnType<typeof successEnvelope>) => void) | undefined
    runtimeCall.mockReturnValue(
      new Promise((resolve) => {
        resolveCall = resolve
      })
    )
    await renderDialog({ sourceAgentType: 'codex', targetAgentType: 'pi' })

    await clickButton('Allow')
    await clickButton('Allow')
    expect(runtimeCall).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveCall?.(successEnvelope(recordFor('codex', 'pi', 'allow')))
    })
  })
})
