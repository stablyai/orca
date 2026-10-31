import { act, createElement, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'
import type { NativeChatReservedAttachment } from './native-chat-session-attachment-drop'
import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'

type HookApi = ReturnType<typeof useNativeChatComposerPaste>

type FakeChip = { id: string; path: string; previewUrl?: string; pending: boolean }

export function createChipStore(): {
  chips: FakeChip[]
  begin: (previewUrl?: string) => string | null
  resolve: (id: string, path: string, connectionId?: string | null) => void
  reveal: (id: string, previewUrl?: string) => void
  drop: (id: string) => void
  connectionIds: (string | null | undefined)[]
} {
  const chips: FakeChip[] = []
  const connectionIds: (string | null | undefined)[] = []
  let counter = 0
  return {
    chips,
    connectionIds,
    reveal: (id, previewUrl) => {
      const chip = chips.find((candidate) => candidate.id === id)
      if (chip) {
        chip.previewUrl = previewUrl
      }
    },
    begin: (previewUrl) => {
      counter += 1
      const id = `chip-${counter}`
      chips.push({ id, path: '', previewUrl, pending: true })
      return id
    },
    resolve: (id, path, connectionId) => {
      const chip = chips.find((candidate) => candidate.id === id)
      if (chip) {
        chip.path = path
        chip.pending = false
      }
      connectionIds.push(connectionId)
    },
    drop: (id) => {
      const index = chips.findIndex((candidate) => candidate.id === id)
      if (index !== -1) {
        chips.splice(index, 1)
      }
    }
  }
}

type ProbeArgs = {
  targetKey?: string
  agent?: 'claude' | 'omp'
  disabled: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths: (paths: string[], connectionId?: string | null) => void
  attachCopiedFiles: (paths: string[]) => void
  captureCopiedFiles: () => (reserved: NativeChatReservedAttachment[]) => Promise<void>
  beginPendingImageAttachment: (previewUrl?: string) => string | null
  resolvePendingImageAttachment: (id: string, path: string, connectionId?: string | null) => void
  revealPendingImageAttachment: (id: string, previewUrl?: string) => void
  dropPendingImageAttachment: (id: string) => void
  insertTypedText: (text: string) => boolean
  setNotice: (notice: string | null) => void
  onReady: (api: HookApi) => void
}

function Probe({ onReady, ...args }: ProbeArgs): null {
  const api = useNativeChatComposerPaste({ agent: 'claude', caret: 0, setCaret: () => {}, ...args })
  useLayoutEffect(() => onReady(api))
  return null
}

let root: Root | null = null

export function unmountPasteProbe(): void {
  root?.unmount()
  root = null
}

export async function renderProbe(args: {
  agent?: 'claude' | 'omp'
  disabled?: boolean
  resolveAttachmentOwner: () => NativeChatAttachmentOwner
  attachResolvedPaths?: (paths: string[], connectionId?: string | null) => void
  attachCopiedFiles?: (paths: string[]) => void
  /** Receives the chips a macOS paste reserved, once the clipboard shows they are files. */
  continueCopiedFiles?: (reserved: NativeChatReservedAttachment[]) => Promise<void>
  store?: ReturnType<typeof createChipStore>
  insertTypedText?: (text: string) => boolean
  setNotice?: (notice: string | null) => void
}): Promise<{
  latest: () => HookApi
  setDisabled: (disabled: boolean) => Promise<void>
  setTarget: (key: string) => Promise<void>
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const store = args.store ?? createChipStore()
  let api: HookApi | null = null
  root = createRoot(container)
  let targetKey = 'session-1'
  const render = async (disabled: boolean): Promise<void> => {
    await act(async () => {
      root?.render(
        createElement(Probe, {
          targetKey,
          agent: args.agent ?? 'claude',
          disabled,
          resolveAttachmentOwner: args.resolveAttachmentOwner,
          attachResolvedPaths: args.attachResolvedPaths ?? (() => {}),
          attachCopiedFiles: args.attachCopiedFiles ?? (() => {}),
          captureCopiedFiles: () => args.continueCopiedFiles ?? (async () => {}),
          beginPendingImageAttachment: args.agent === 'omp' ? () => null : store.begin,
          resolvePendingImageAttachment: store.resolve,
          revealPendingImageAttachment: store.reveal,
          dropPendingImageAttachment: store.drop,
          insertTypedText: args.insertTypedText ?? (() => true),
          setNotice: args.setNotice ?? (() => {}),
          onReady: (next) => {
            api = next
          }
        })
      )
    })
  }
  await render(args.disabled ?? false)
  return {
    latest: () => {
      if (!api) {
        throw new Error('Probe did not render')
      }
      return api
    },
    setDisabled: render,
    setTarget: async (key) => {
      targetKey = key
      await render(false)
    }
  }
}
