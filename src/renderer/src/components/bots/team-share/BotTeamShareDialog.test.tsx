// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import type React from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { Bot } from '../../../../../shared/bot-types'
import type { TeamSharePerson } from './bot-team-share-people'
import { BotTeamShareDialog } from './BotTeamShareDialog'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the dialog reads only these fields.
const bot = { id: 'ivy', name: 'Ivy', hostId: 'local', avatar: null } as unknown as Bot

function renderWith(people: readonly TeamSharePerson[], connectorRows?: React.ReactNode): void {
  render(
    <TooltipProvider>
      <BotTeamShareDialog
        bot={bot}
        hostName="this computer"
        owner={null}
        people={people}
        query=""
        onQueryChange={() => {}}
        suggestions={null}
        staged={[]}
        onStage={() => {}}
        onUnstage={() => {}}
        onShare={() => {}}
        onCancelStaged={() => {}}
        onRemove={() => {}}
        onResend={() => {}}
        onShareAgain={() => {}}
        onClose={() => {}}
      >
        {connectorRows}
      </BotTeamShareDialog>
    </TooltipProvider>
  )
}

function EmptyConnector(): null {
  return null
}

afterEach(cleanup)

describe('the Share dialog’s People with access heading', () => {
  it('shows only once a row renders under it', () => {
    renderWith([])
    expect(screen.queryByText('People with access')).toBeNull()
    cleanup()
    // A connector whose people list is empty renders no row.
    renderWith([], <EmptyConnector />)
    expect(screen.queryByText('People with access')).toBeNull()
    cleanup()
    renderWith([{ kind: 'invite', key: 'dana', email: 'dana@acme.co' }])
    expect(screen.getByText('People with access')).toBeTruthy()
  })
})
