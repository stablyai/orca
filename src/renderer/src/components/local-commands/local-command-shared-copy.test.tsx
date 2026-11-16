// @vitest-environment happy-dom
// Workspaces aren't shared with the team: the approval dialog says nothing about teammates, even
// for a workspace the control plane still runs in shared mode (one whose owner changed).
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

import { Dialog } from '@/components/ui/dialog'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LocalCommandApprovalDialogView } from './LocalCommandApprovalDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

async function show(): Promise<string> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const prompt = {
    requestId: 'r1',
    workspace: 'web',
    command: 'ls -la',
    cwd: '/tmp',
    shared: true,
    timeoutSeconds: 120
  }
  await act(async () =>
    root!.render(
      <TooltipProvider>
        <Dialog open>
          <LocalCommandApprovalDialogView
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the view reads only these prompt fields here.
            prompt={prompt as never}
            waitingCount={0}
            ready
            busy={false}
            onDecide={() => {}}
            onTurnOff={() => {}}
          />
        </Dialog>
      </TooltipProvider>
    )
  )
  return document.body.textContent ?? ''
}

describe('a local command request', () => {
  it('never mentions teammates', async () => {
    const text = await show()
    expect(text).not.toMatch(/teammate/i)
    expect(text).toContain('ls -la')
  })
})
