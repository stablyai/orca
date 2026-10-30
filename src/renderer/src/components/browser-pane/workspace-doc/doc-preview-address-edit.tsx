import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import BrowserAddressBar from '@/components/browser-pane/assemble-chrome/BrowserAddressBar'
import { resolveBrowserAddressBarSubmission } from '@/components/browser-pane/navigate/browser-address-bar-navigation'
import { translate } from '@/i18n/i18n'
import { convertBrowserPageToWorkspaceDoc } from '@/lib/file-preview'
import { resolveWorkspaceDocAddressTarget } from '@/lib/workspace-doc-address-input'
import { useAppStore } from '@/store'
import { DocPreviewDocumentChip } from './doc-preview-document-chip'
import type { DocPreviewDocumentIdentity } from './doc-preview-document-identity'

/** Edit the workspace-relative path in place; successful web URL conversion replaces this pane, while refusal leaves it mounted. */
export function DocPreviewAddressEdit({
  identity,
  previewId,
  worktreeId
}: {
  identity: DocPreviewDocumentIdentity
  previewId: string
  worktreeId: string
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const dismissSuggestionsRef = useRef<(() => void) | null>(null)
  const exitTimerRef = useRef<number | null>(null)

  const beginEdit = useCallback((): void => {
    setValue(`${identity.directoryPrefix}${identity.fileName}`)
    setEditing(true)
  }, [identity.directoryPrefix, identity.fileName])

  const exitEdit = useCallback((): void => {
    if (exitTimerRef.current !== null) {
      window.clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }
    setEditing(false)
  }, [])

  useEffect(() => {
    if (!editing) {
      return
    }
    const input = inputRef.current
    input?.focus()
    input?.select()
    return () => {
      if (exitTimerRef.current !== null) {
        window.clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }
  }, [editing])

  const navigateToUrl = useCallback(
    (url: string): void => {
      // Suggestion clicks bypass typed-input validation; file: would read a remote document path on this machine.
      if (url.startsWith('file:')) {
        toast.error(
          translate(
            'auto.components.browser.pane.BrowserPane.fileUrlUnsupported',
            'This browser tab cannot open local files. Use "Open Preview to the Side" on the file instead.'
          )
        )
        return
      }
      const converted = useAppStore.getState().convertBrowserPage(previewId, { kind: 'web', url })
      if (!converted) {
        exitEdit()
      }
    },
    [exitEdit, previewId]
  )

  const submit = useCallback((): void => {
    const typed = inputRef.current?.value ?? ''
    // Workspace paths retarget the preview or activate the document’s existing tab.
    const docTarget = resolveWorkspaceDocAddressTarget(useAppStore.getState(), worktreeId, typed)
    if (docTarget.status === 'workspace-doc') {
      convertBrowserPageToWorkspaceDoc(previewId, docTarget.docLocation)
      exitEdit()
      return
    }
    if (docTarget.status === 'unsupported') {
      toast.error(docTarget.message)
      return
    }
    const submission = resolveBrowserAddressBarSubmission(typed, {
      allowFileUrls: false
    })
    if (submission.status === 'navigate') {
      navigateToUrl(submission.url)
      return
    }
    toast.error(submission.loadError.description)
  }, [exitEdit, navigateToUrl, previewId, worktreeId])

  if (!editing) {
    return <DocPreviewDocumentChip identity={identity} onBeginEdit={beginEdit} />
  }

  return (
    <div
      className="flex min-w-0 flex-1"
      onBlur={(event) => {
        // Blur precedes suggestion clicks; defer exit so unmount cannot swallow the commit.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return
        }
        exitTimerRef.current = window.setTimeout(() => setEditing(false), 200)
      }}
      onFocus={() => {
        if (exitTimerRef.current !== null) {
          window.clearTimeout(exitTimerRef.current)
          exitTimerRef.current = null
        }
      }}
    >
      <BrowserAddressBar
        pageId={previewId}
        value={value}
        committedValue={`${identity.directoryPrefix}${identity.fileName}`}
        onLeave={exitEdit}
        onChange={setValue}
        onSubmit={submit}
        onNavigate={navigateToUrl}
        onOpenWorkspaceDoc={(docLocation) => {
          convertBrowserPageToWorkspaceDoc(previewId, docLocation)
          exitEdit()
        }}
        inputRef={inputRef}
        dismissSuggestionsRef={dismissSuggestionsRef}
      />
    </div>
  )
}
