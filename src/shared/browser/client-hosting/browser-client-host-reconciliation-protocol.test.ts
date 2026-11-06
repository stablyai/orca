import { describe, expect, it } from 'vitest'
import {
  BROWSER_CLIENT_HOST_PAGE_RECONCILIATION_PROTOCOL_VERSION,
  BrowserClientHostAttachParams,
  BrowserClientHostCommandEvent,
  BrowserClientHostReady
} from './browser-client-host-protocol'

const inventoryPage = {
  authorityRuntimeId: 'runtime-old',
  authorityEpoch: 'epoch-old',
  browserHostClientId: 'host-a',
  browserHostGeneration: 2,
  browserPageId: 'page-a',
  pageHostGeneration: 3,
  browserProfileId: 'profile-a',
  executionHostKey: 'native:runtime-a:1',
  state: 'active' as const
}

/** Raw command input for the parser under test, including deliberately malformed shapes. */
type RawReconciliationCommand = { type: string } & Record<string, unknown>

const command = (reconciliationCommand: RawReconciliationCommand) => ({
  type: 'command' as const,
  authorityRuntimeId: 'runtime-a',
  authorityEpoch: 'epoch-new',
  browserHostClientId: 'host-a',
  browserHostGeneration: 4,
  pageCommandProtocolVersion: 1 as const,
  pageReconciliationProtocolVersion: 1 as const,
  browserPageId: 'page-a',
  pageHostGeneration: 5,
  commandSequence: 6,
  commandId: 'command-a',
  command: reconciliationCommand
})

describe('browser client-host reconciliation protocol', () => {
  it('negotiates reconciliation only beside commands and complete inventory', () => {
    expect(
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageInventory: [inventoryPage],
        pageReconciliationProtocolVersion: BROWSER_CLIENT_HOST_PAGE_RECONCILIATION_PROTOCOL_VERSION
      })
    ).toMatchObject({ pageReconciliationProtocolVersion: 1 })
    expect(
      BrowserClientHostReady.parse({
        type: 'ready',
        authorityEpoch: 'epoch-new',
        browserHostGeneration: 4,
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageReconciliationProtocolVersion: 1
      })
    ).toMatchObject({ pageReconciliationProtocolVersion: 1 })

    for (const incomplete of [
      { pageCommandProtocolVersion: 1 },
      { pageInventoryProtocolVersion: 1, pageInventory: [inventoryPage] }
    ]) {
      expect(() =>
        BrowserClientHostAttachParams.parse({
          authorityRuntimeId: 'runtime-a',
          browserHostClientId: 'host-a',
          hostCapabilities: ['webview'],
          pageReconciliationProtocolVersion: 1,
          ...incomplete
        })
      ).toThrow('Browser page reconciliation requires command and inventory negotiation')
    }
  })

  it('decodes exact reclaim, close, and restore commands only after negotiation', () => {
    const previousAuthority = {
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'host-a',
      browserHostGeneration: 2,
      pageHostGeneration: 3
    }
    const reconciliationCommands = [
      {
        type: 'reclaimPage',
        previousAuthority,
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:1'
      },
      { type: 'closePage', targetAuthority: previousAuthority },
      {
        type: 'restorePage',
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:1',
        url: 'https://remote.internal/'
      }
    ]

    for (const reconciliationCommand of reconciliationCommands) {
      expect(BrowserClientHostCommandEvent.parse(command(reconciliationCommand))).toMatchObject({
        pageReconciliationProtocolVersion: 1,
        command: reconciliationCommand
      })
      const unnegotiated = command(reconciliationCommand)
      delete (unnegotiated as { pageReconciliationProtocolVersion?: number })
        .pageReconciliationProtocolVersion
      expect(() => BrowserClientHostCommandEvent.parse(unnegotiated)).toThrow(
        'Browser page reconciliation command was not negotiated'
      )
    }
  })

  it('rejects stale reclaim authority and malformed restore inputs', () => {
    expect(() =>
      BrowserClientHostCommandEvent.parse(
        command({
          type: 'reclaimPage',
          previousAuthority: {
            authorityRuntimeId: 'runtime-a',
            authorityEpoch: 'epoch-new',
            browserHostClientId: 'host-a',
            browserHostGeneration: 2,
            pageHostGeneration: 3
          },
          browserProfileId: 'profile-a',
          executionHostKey: 'native:runtime-a:1'
        })
      )
    ).toThrow('Browser page reclaim requires an older authority epoch')
    expect(() =>
      BrowserClientHostCommandEvent.parse(
        command({
          type: 'restorePage',
          browserProfileId: '',
          executionHostKey: 'native:runtime-a:1'
        })
      )
    ).toThrow()
  })

  it.each([
    {
      type: 'createPage',
      browserProfileId: 'profile-a',
      executionHostKey: 'native:runtime-a:1'
    },
    { type: 'navigate', url: 'https://remote.internal/' }
  ])('leaves legacy $type commands unchanged', (legacyPageCommand) => {
    const legacyCommand = Object.fromEntries(
      Object.entries(command(legacyPageCommand)).filter(
        ([key]) => key !== 'pageReconciliationProtocolVersion'
      )
    )

    expect(BrowserClientHostCommandEvent.parse(legacyCommand)).toEqual(legacyCommand)
  })
})
