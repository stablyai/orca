// @vitest-environment happy-dom
// TEAM-SHARING-HOLD: the approval dialog says nothing about teammates while team sharing is held.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const teamSharing = vi.hoisted(() => ({ on: false }))
vi.mock('@/lib/orca-cloud/cloud-team-sharing-flag', () => ({
  cloudTeamSharingEnabled: () => teamSharing.on,
  useCloudTeamSharingEnabled: () => teamSharing.on
}))

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

describe('the teammates note on a local command request', () => {
  it('held: no mention of teammates', async () => {
    teamSharing.on = false
    expect(await show()).not.toContain('Teammates share this workspace')
  })

  it('sharing on: says a teammate may have led to it', async () => {
    teamSharing.on = true
    expect(await show()).toContain('Teammates share this workspace')
  })
})
