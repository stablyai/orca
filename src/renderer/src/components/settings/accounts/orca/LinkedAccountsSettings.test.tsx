// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConfirmationDialogProvider } from '@/components/dismiss/confirmation/confirmation-dialog'
import type { ConnectorLink } from '../../../../../../shared/connectors/connector-links-contract'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { LinkedAccountsSettings } from './LinkedAccountsSettings'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))

const LINKS: ConnectorLink[] = [
  {
    source: 'slack',
    workspaceId: 'T1',
    workspaceName: 'Northwind',
    userId: 'U1',
    name: 'Mara',
    linkedAt: 1
  },
  {
    source: 'slack',
    workspaceId: 'T2',
    workspaceName: 'Acme Partners',
    userId: 'U2',
    name: 'mara',
    linkedAt: 2
  },
  {
    source: 'github',
    workspaceId: 'github.com',
    workspaceName: '',
    userId: '7',
    name: 'mara-lin',
    linkedAt: 3
  }
]
const SERVER = toRuntimeExecutionHostId('env_lab')

afterEach(() => {
  cleanup()
  mocks.call.mockReset()
})

/** The server answers its links list and unlinks; other connector reads fail quietly. */
function serve(): { method: string; params: unknown }[] {
  const asked: { method: string; params: unknown }[] = []
  mocks.call.mockImplementation(async (target: unknown, method: string, params: unknown) => {
    expect(target).toEqual({ kind: 'environment', environmentId: 'env_lab' })
    asked.push({ method, params })
    if (method === 'bots.links.list') {
      return { ok: true, value: { links: LINKS } }
    }
    return method === 'bots.links.unlink' ? { ok: true } : { ok: false, error: 'failed' }
  })
  return asked
}

function show(): void {
  render(
    <ConfirmationDialogProvider>
      <LinkedAccountsSettings hostId={SERVER} hostName="Lab server" />
    </ConfirmationDialogProvider>
  )
}

describe('Linked accounts', () => {
  it("lists a paired server's links, several per service", async () => {
    serve()
    show()
    expect(await screen.findByText('Northwind')).toBeTruthy()
    expect(screen.getByText('Acme Partners')).toBeTruthy()
    expect(screen.getByText('mara-lin')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Unlink' })).toHaveLength(3)
  })

  it('unlinks one link only after the confirm', async () => {
    const asked = serve()
    show()
    await screen.findByText('Acme Partners')
    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[1]!)
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Unlink Acme Partners on Slack?')).toBeTruthy()
    expect(asked.some(({ method }) => method === 'bots.links.unlink')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink' }))
    await waitFor(() =>
      expect(asked).toContainEqual({
        method: 'bots.links.unlink',
        params: { source: 'slack', workspaceId: 'T2', userId: 'U2' }
      })
    )
  })
})
