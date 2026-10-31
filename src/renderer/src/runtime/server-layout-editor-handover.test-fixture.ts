// Use main’s real command model for paired editor handover, including idempotent reopen and taken-ID refusal; publish frame before reply.

import { createBrowserUuid } from '@/lib/browser-uuid'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import type {
  LayoutApplyReply,
  LayoutCommand
} from '../../../shared/workspace-layout/workspace-layout-command-types'
import { workspaceLayoutModelFromPublished } from '../../../shared/workspace-layout/workspace-layout-from-published'
import type { WorkspaceLayoutModel } from '../../../shared/workspace-layout/workspace-layout-model'
import {
  publishWorkspaceLayout,
  type PublishedWorkspaceLayout
} from '../../../shared/workspace-layout/workspace-layout-published'
import { mainLayoutFrameSender } from './main-loaded-layout-frames.test-fixture'
import type { FakeLayoutStream, createFakeLayoutStreams } from './server-layout-frames.test-fixture'
import { senderSnapshot } from './server-layout-frames.test-fixture'

type Refusal = Extract<LayoutApplyReply, { ok: false }>['code']

/** `apply`: main applies it; `pending`: no answer until `release`; `throw`: the call fails. */
export type ServerAnswer = 'apply' | 'pending' | 'throw' | { refuse: Refusal }

export function createFakeServerMain(
  streams: ReturnType<typeof createFakeLayoutStreams>,
  layouts: Record<string, PublishedWorkspaceLayout>
) {
  let model: WorkspaceLayoutModel = workspaceLayoutModelFromPublished('local', layouts)
  let seq = 1
  let stream: FakeLayoutStream | null = null
  let frames = mainLayoutFrameSender()
  const held: { command: LayoutCommand; resolve: (reply: LayoutApplyReply) => void }[] = []
  const published = (): Record<string, PublishedWorkspaceLayout> =>
    Object.fromEntries(
      Object.entries(model.workspaces).map(([key, workspace]) => [
        key,
        publishWorkspaceLayout(workspace, 'local')
      ])
    )
  const apply = (command: LayoutCommand): LayoutApplyReply => {
    const applied = applyLayoutCommand(model, command, {
      mintId: createBrowserUuid,
      mintLeafId: createBrowserUuid,
      now: () => 5
    })
    if (!applied.ok) {
      return applied
    }
    model = applied.model
    seq += 1
    if (stream && !stream.closed) {
      streams.send(stream, frames.records(command.workspace, published()[command.workspace]!, seq))
    }
    return { ok: true, result: applied.result, frameSeq: seq }
  }
  let answer: ServerAnswer = 'apply'
  const sent: LayoutCommand[] = []
  const server = {
    get answer(): ServerAnswer {
      return answer
    },
    set answer(next: ServerAnswer) {
      answer = next
    },
    /** Every command the desktop sent this server, as sent. */
    sent,
    layout: (key: string): PublishedWorkspaceLayout | undefined => published()[key],
    /** Opens the desktop's stream to this server with its snapshot. */
    connect: (to: FakeLayoutStream): void => {
      stream = to
      frames = mainLayoutFrameSender()
      streams.send(to, senderSnapshot(frames, published(), seq))
    },
    /** The desktop's stream is gone: no frame reaches it. */
    disconnect: (): void => {
      stream = null
    },
    /** Publishes a change made on the server itself. */
    change: (key: string, layout: PublishedWorkspaceLayout): void => {
      model = workspaceLayoutModelFromPublished('local', { ...published(), [key]: layout })
      seq += 1
      if (stream && !stream.closed) {
        streams.send(stream, frames.records(key, layout, seq))
      }
    },
    reply: (command: LayoutCommand): Promise<LayoutApplyReply> => {
      sent.push(command)
      const now = answer
      if (now === 'throw') {
        return Promise.reject(new Error('connection lost'))
      }
      if (now === 'pending') {
        return new Promise((resolve) => held.push({ command, resolve }))
      }
      // Never inside the send: the window is mid-frame when it hands tabs over.
      return Promise.resolve().then(() =>
        now === 'apply' ? apply(command) : { ok: false, code: now.refuse }
      )
    },
    /** session.tabs.close of one tab, as that main applies it to its layout. */
    closeTab: (workspace: string, tabId: string): 'applied' | 'unknown-tab' => {
      const reply = apply({ type: 'closeTabs', tabIds: [tabId], workspace })
      return reply.ok && reply.result.closed?.includes(tabId) ? 'applied' : 'unknown-tab'
    },
    /** Applies the first `count` held commands (all by default) now and answers them. */
    release: (count = held.length): void => {
      for (const { command, resolve } of held.splice(0, count)) {
        resolve(apply(command))
      }
    }
  }
  return server
}
