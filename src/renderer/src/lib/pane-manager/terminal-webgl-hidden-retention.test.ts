import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { resumePaneRendering, suspendPaneRendering } from './pane-rendering-control'
import {
  resetHiddenWebglRetentionForTest,
  retainedHiddenWebglOwnerCountForTest,
  type HiddenWebglRetentionOwner
} from './terminal-webgl-hidden-retention'

function createPane(withAddon = true): ManagedPaneInternal {
  return {
    // options mirrors the real Terminal: suspend parks cursorBlink here.
    terminal: { blur: vi.fn(), options: { cursorBlink: true } },
    webglAddon: withAddon
      ? ({ dispose: vi.fn() } as unknown as ManagedPaneInternal['webglAddon'])
      : null,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    webglAttachFailedSinceRecovery: false,
    gpuRenderingEnabled: true,
    pendingWebglRefreshRafId: null
  } as unknown as ManagedPaneInternal
}

function retentionFor(owner: HiddenWebglRetentionOwner, panes: ManagedPaneInternal[]) {
  return { owner, livePanes: () => panes }
}

describe('terminal-webgl-hidden-retention', () => {
  beforeEach(() => {
    resetHiddenWebglRetentionForTest()
  })

  it('evicts the least-recently-hidden owner over the context cap', () => {
    const ownerA = {}
    const panesA = [createPane(), createPane(), createPane()]
    const addonsA = panesA.map((pane) => pane.webglAddon)
    suspendPaneRendering(panesA, retentionFor(ownerA, panesA))

    const ownerB = {}
    const panesB = [createPane(), createPane(), createPane()]
    suspendPaneRendering(panesB, retentionFor(ownerB, panesB))

    // A(3) + B(3) fits the cap of 6; C(2) forces A out.
    const ownerC = {}
    const panesC = [createPane(), createPane()]
    suspendPaneRendering(panesC, retentionFor(ownerC, panesC))

    expect(panesA.every((pane) => pane.webglAddon === null)).toBe(true)
    for (const addon of addonsA) {
      expect(addon?.dispose).toHaveBeenCalled()
    }
    expect(panesB.every((pane) => pane.webglAddon != null)).toBe(true)
    expect(panesC.every((pane) => pane.webglAddon != null)).toBe(true)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(2)
  })

  it('re-suspending an owner refreshes its LRU position', () => {
    const ownerA = {}
    const panesA = [createPane(), createPane(), createPane()]
    suspendPaneRendering(panesA, retentionFor(ownerA, panesA))
    const ownerB = {}
    const panesB = [createPane(), createPane(), createPane()]
    suspendPaneRendering(panesB, retentionFor(ownerB, panesB))

    suspendPaneRendering(panesA, retentionFor(ownerA, panesA))
    const ownerC = {}
    const panesC = [createPane()]
    suspendPaneRendering(panesC, retentionFor(ownerC, panesC))

    expect(panesB.every((pane) => pane.webglAddon === null)).toBe(true)
    expect(panesA.every((pane) => pane.webglAddon != null)).toBe(true)
  })

  it('does not retain a single owner wider than the whole cap', () => {
    const owner = {}
    const panes = Array.from({ length: 7 }, () => createPane())
    const addons = panes.map((pane) => pane.webglAddon)
    suspendPaneRendering(panes, retentionFor(owner, panes))
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
    for (const addon of addons) {
      expect(addon?.dispose).toHaveBeenCalled()
    }
  })

  it('resume releases retention bookkeeping and keeps the live addon', () => {
    const owner = {}
    const panes = [createPane()]
    suspendPaneRendering(panes, retentionFor(owner, panes))
    resumePaneRendering(panes, owner)
    expect(retainedHiddenWebglOwnerCountForTest()).toBe(0)
    expect(panes[0].webglAddon).not.toBeNull()
    expect(panes[0].webglAttachmentDeferred).toBe(false)
    const others = [{}, {}]
    for (const other of others) {
      const otherPanes = [createPane(), createPane(), createPane()]
      suspendPaneRendering(otherPanes, retentionFor(other, otherPanes))
      expect(otherPanes.every((pane) => pane.webglAddon != null)).toBe(true)
    }
  })

  it('eviction accounting survives addons disposed after retention (GPU toggle off)', () => {
    const ownerA = {}
    const panesA = [createPane(), createPane(), createPane(), createPane()]
    suspendPaneRendering(panesA, retentionFor(ownerA, panesA))
    for (const pane of panesA) {
      pane.webglAddon = null
    }
    const ownerB = {}
    const panesB = Array.from({ length: 6 }, () => createPane())
    suspendPaneRendering(panesB, retentionFor(ownerB, panesB))
    expect(panesB.every((pane) => pane.webglAddon != null)).toBe(true)
  })
})
