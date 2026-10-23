import { act, createElement, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'
import { useNativeChatComposerAttachments } from './use-native-chat-composer-attachments'

type AttachmentApi = ReturnType<typeof useNativeChatComposerAttachments>
type ProbeApi = AttachmentApi & { adoptDraft: (draft: string) => void }

const target: NativeChatResolvedTarget = {
  ptyId: 'pty-1'
}

function Probe({
  scopeKey,
  structured = false,
  disabled = false,
  isComposing,
  onReady
}: {
  scopeKey: string
  structured?: boolean
  disabled?: boolean
  isComposing: () => boolean
  onReady: (api: ProbeApi) => void
}): React.JSX.Element {
  const [caret, setCaret] = useState(0)
  const [draftValue, setDraftValue] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const api = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    allowWithoutTarget: structured,
    imageReferences: structured,
    caret,
    disabled,
    isComposing,
    resolveTarget: () => (structured ? null : target),
    textareaRef,
    setCaret,
    setDraft: (updater) => setDraftValue((previous) => updater(previous)),
    setNotice
  })
  useEffect(() => {
    onReady({ ...api, adoptDraft: setDraftValue })
  }, [api, onReady])
  return (
    <div>
      <textarea ref={textareaRef} />
      <output data-draft>{draftValue}</output>
      <output data-notice>{notice}</output>
    </div>
  )
}

export async function renderProbe(
  scopeKey: string,
  structured = false,
  options: { disabled?: boolean; isComposing?: () => boolean } = {}
): Promise<{
  draft: () => string
  latest: () => ProbeApi
  notice: () => string
  rerender: (scopeKey: string, disabled?: boolean) => Promise<void>
  root: Root
  textarea: () => HTMLTextAreaElement
}> {
  const container = document.createElement('div')
  document.body.append(container)
  // onReady fires on every render, so keep the freshest snapshot — reading a
  // single captured `api` would go stale after attach/remove triggers a render.
  let api: ProbeApi | null = null
  const root = createRoot(container)
  const onReady = (next: ProbeApi): void => {
    api = next
  }
  const isComposing = options.isComposing ?? (() => false)
  const render = async (nextScopeKey: string, disabled: boolean): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(Probe, {
          scopeKey: nextScopeKey,
          structured,
          disabled,
          isComposing,
          onReady
        })
      )
    })
  }
  await render(scopeKey, options.disabled ?? false)
  if (!api) {
    throw new Error('Probe did not render')
  }
  return {
    draft: () => container.querySelector('[data-draft]')?.textContent ?? '',
    root,
    latest: () => {
      if (!api) {
        throw new Error('Probe is not mounted')
      }
      return api
    },
    notice: () => container.querySelector('[data-notice]')?.textContent ?? '',
    rerender: (nextScopeKey: string, disabled = options.disabled ?? false) =>
      render(nextScopeKey, disabled),
    textarea: () => {
      const textarea = container.querySelector('textarea')
      if (!textarea) {
        throw new Error('Probe textarea is not mounted')
      }
      return textarea
    }
  }
}
