import { describe, expect, it } from 'vitest'
import { z } from 'zod'
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

const command = (reconciliationCommand: object) => ({
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

  it('keeps optional negotiation fields invisible to old attach and ready decoders', () => {
    const legacyAttach = z.object({
      authorityRuntimeId: z.string(),
      browserHostClientId: z.string(),
      hostCapabilities: z.array(z.string()),
      pageCommandProtocolVersion: z.literal(1).optional()
    })
    const legacyReady = z.object({
      type: z.literal('ready'),
      authorityEpoch: z.string(),
      browserHostGeneration: z.number(),
      pageCommandProtocolVersion: z.literal(1).optional()
    })

    expect(
      legacyAttach.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageInventory: [],
        pageReconciliationProtocolVersion: 1
      })
    ).not.toHaveProperty('pageReconciliationProtocolVersion')
    expect(
      legacyReady.parse({
        type: 'ready',
        authorityEpoch: 'epoch-new',
        browserHostGeneration: 4,
        pageCommandProtocolVersion: 1,
        pageInventoryProtocolVersion: 1,
        pageReconciliationProtocolVersion: 1
      })
    ).not.toHaveProperty('pageReconciliationProtocolVersion')
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

  it('leaves legacy create and navigate commands unchanged', () => {
    const legacyCommand = {
      ...command({
        type: 'createPage',
        browserProfileId: 'profile-a',
        executionHostKey: 'native:runtime-a:1'
      })
    }
    delete (legacyCommand as { pageReconciliationProtocolVersion?: number })
      .pageReconciliationProtocolVersion

    expect(BrowserClientHostCommandEvent.parse(legacyCommand)).toEqual(legacyCommand)
  })
})
