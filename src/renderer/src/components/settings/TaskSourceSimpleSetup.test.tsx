// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JiraSetupSteps } from './TaskSourceSimpleSetup'

const mocks = vi.hoisted(() => ({
  dialogOpen: [] as boolean[]
}))

vi.mock('@/components/jira-connect-dialog', () => ({
  JiraConnectDialog: ({ open }: { open: boolean }) => {
    mocks.dialogOpen.push(open)
    return null
  }
}))

afterEach(() => {
  cleanup()
  mocks.dialogOpen = []
})

describe('JiraSetupSteps', () => {
  it('routes connected credential management to Integrations', () => {
    const onOpenIntegrations = vi.fn()
    const rendered = render(
      <JiraSetupSteps
        connected
        checking={false}
        visible
        canHide
        onToggleVisible={vi.fn()}
        onConnected={vi.fn()}
        onOpenIntegrations={onOpenIntegrations}
      />
    )

    fireEvent.click(rendered.getByRole('button', { name: 'Manage keys' }))

    expect(onOpenIntegrations).toHaveBeenCalledOnce()
    expect(mocks.dialogOpen.at(-1)).toBe(false)
  })
})
