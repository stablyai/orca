import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MobileWebSessionSnapshotResultSchema } from './session-operation-contract'
import { tolerantMobileWebShellPayload } from './shell-payload-tolerance'

const SNAPSHOT = {
  workspaceId: 'workspace-1',
  publicationEpoch: 'epoch-1',
  snapshotVersion: 3,
  activeTabId: 'tab-1',
  activeTabType: 'terminal' as const,
  tabs: [{ id: 'tab-1', title: 'Terminal', isActive: true, type: 'terminal', status: 'ready' }],
  truncated: false
}

describe('mobile web shell payload tolerance', () => {
  const snapshot = tolerantMobileWebShellPayload(MobileWebSessionSnapshotResultSchema)

  it('keeps a newer shell snapshot readable by dropping only what the page cannot name', () => {
    const parsed = snapshot.safeParse({
      ...SNAPSHOT,
      activeTabType: 'canvas',
      sessionRevision: 9,
      tabs: [
        { ...SNAPSHOT.tabs[0], pinned: true },
        { id: 'tab-2', title: 'Canvas', isActive: false, type: 'canvas', documentId: 'd1' }
      ]
    })

    expect(parsed.success).toBe(true)
    expect(parsed.data).toEqual({
      workspaceId: 'workspace-1',
      publicationEpoch: 'epoch-1',
      snapshotVersion: 3,
      activeTabId: 'tab-1',
      activeTabType: null,
      tabs: [{ id: 'tab-1', title: 'Terminal', isActive: true, type: 'terminal', status: 'ready' }],
      truncated: false
    })
  })

  it('collapses an unknown value for an optional closed set instead of failing the payload', () => {
    const parsed = snapshot.safeParse({ ...SNAPSHOT, workspaceTransportState: 'degraded' })

    expect(parsed.success).toBe(true)
    expect((parsed.data as { workspaceTransportState?: string }).workspaceTransportState).toBe(
      undefined
    )
  })

  it('collapses an optional discriminated union the page cannot classify', () => {
    const schema = tolerantMobileWebShellPayload(
      z
        .object({
          keep: z.string(),
          route: z
            .discriminatedUnion('kind', [
              z.object({ kind: z.literal('list') }).strict(),
              z.object({ kind: z.literal('session'), id: z.string() }).strict()
            ])
            .optional()
        })
        .strict()
    )

    expect(schema.safeParse({ keep: 'a', route: { kind: 'futureKind', id: 'x' } })).toEqual({
      success: true,
      data: { keep: 'a' }
    })
    expect(schema.safeParse({ keep: 'a', route: { kind: 'session', id: 'x' } })).toEqual({
      success: true,
      data: { keep: 'a', route: { kind: 'session', id: 'x' } }
    })
    expect(schema.safeParse({ keep: 'a' }).success).toBe(true)
    // A member the page CAN name but whose fields are wrong is a sender bug, not skew.
    expect(schema.safeParse({ keep: 'a', route: { kind: 'session' } }).success).toBe(false)
    expect(schema.safeParse({ keep: 'a', route: 'session' }).success).toBe(false)
  })

  it('still rejects a payload whose known fields are wrong, and keeps refinements', () => {
    expect(snapshot.safeParse({ ...SNAPSHOT, snapshotVersion: -1 }).success).toBe(false)
    expect(snapshot.safeParse({ ...SNAPSHOT, truncated: 'no' }).success).toBe(false)

    const echoed = tolerantMobileWebShellPayload(
      MobileWebSessionSnapshotResultSchema.refine((event) => event.workspaceId === 'workspace-1')
    )
    expect(echoed.safeParse(SNAPSHOT).success).toBe(true)
    expect(echoed.safeParse({ ...SNAPSHOT, workspaceId: 'workspace-2' }).success).toBe(false)
  })

  it('keeps the wire-size cap ahead of member parsing on an array of unions', () => {
    const capped = tolerantMobileWebShellPayload(
      z.object({
        items: z
          .array(z.discriminatedUnion('type', [z.object({ type: z.literal('a') }).strict()]))
          .max(2)
      })
    )

    expect(capped.safeParse({ items: [{ type: 'a' }, { type: 'b' }] }).data).toEqual({
      items: [{ type: 'a' }]
    })
    expect(capped.safeParse({ items: [{ type: 'a' }, { type: 'a' }, { type: 'a' }] }).success).toBe(
      false
    )
  })

  it('reaches strictness nested behind wrappers the contracts actually use', () => {
    const nested = tolerantMobileWebShellPayload(
      z.object({
        entry: z.object({ id: z.string() }).strict().optional(),
        pages: z.record(z.string(), z.object({ id: z.string() }).strict()),
        pair: z.tuple([z.object({ id: z.string() }).strict()]),
        later: z.lazy(() => z.object({ id: z.string() }).strict())
      })
    )

    expect(
      nested.safeParse({
        entry: { id: 'a', extra: 1 },
        pages: { one: { id: 'b', extra: 1 } },
        pair: [{ id: 'c', extra: 1 }],
        later: { id: 'd', extra: 1 }
      })
    ).toEqual({
      success: true,
      data: {
        entry: { id: 'a' },
        pages: { one: { id: 'b' } },
        pair: [{ id: 'c' }],
        later: { id: 'd' }
      }
    })
  })

  it('leaves the source schema strict so page->shell requests keep their fence', () => {
    expect(
      MobileWebSessionSnapshotResultSchema.safeParse({ ...SNAPSHOT, sessionRevision: 9 }).success
    ).toBe(false)
  })
})
