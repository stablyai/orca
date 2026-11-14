import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'
import {
  useCustomEditorViewStore,
  type ActivePluginCustomEditor
} from '@/store/plugins/file-editors/plugin-custom-editors'
import { PLUGIN_PANEL_FRAME_NAME_PREFIX } from '../../../../shared/plugins/frames/plugin-frame-bridge'
import { CUSTOM_EDITOR_LARGE_DOCUMENT_BYTES } from '../../../../shared/plugins/frames/plugin-custom-editor-bridge'
import { fillPluginPanelShell } from '../plugins/frames/plugin-panel-design-token-css'
import {
  PluginFrameView,
  pluginFrameWindowOf,
  usablePluginFrameGuest,
  type PluginFrameElement
} from '../plugins/frames/plugin-frame-element'
import { usePluginFrameHost } from '../plugins/frames/use-plugin-frame-host'
import { usePluginFrameEntry } from '../plugins/frames/use-plugin-frame-entry'
import { editorShortcutMatches } from './editor-shortcuts'
import {
  countCustomEditorMergingView,
  useCustomEditorOutsideMerge
} from './use-custom-editor-outside-merge'
import { registerEditorFrameFlush } from './save/flush/editor-pending-flush'
import { useCustomEditorReloadFlush } from './use-custom-editor-reload-flush'
import { PluginEditorNeedsDesktopNotice } from './PluginEditorNeedsDesktopNotice'
import {
  usePluginEditorCaptureReport,
  usePluginEditorCaptureView
} from './plugin-editor-capture-status'
import { createCustomEditorHost } from './plugin-custom-editor-host'
import type {
  CustomEditorBinaryDocument,
  CustomEditorEditRefusal
} from './plugin-custom-editor-host-types'

type PluginCustomEditorFrameProps = {
  editor: ActivePluginCustomEditor
  /** The tab's file id; every save of it first flushes this frame. */
  fileId?: string
  content: string
  readOnly: boolean
  onContentChange: (content: string) => void
  onSave: (content: string) => Promise<boolean>
  /** Marks the tab dirty while the frame holds edits the buffer lacks. */
  onDirtyHint?: (dirty: boolean) => void
  /** Set for a binary editor: its bytes once loaded (null before). Text props are then unused. */
  binaryDocument?: CustomEditorBinaryDocument | null
  onBytesChange?: (document: CustomEditorBinaryDocument) => void
}

function FrameMessage({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

/** A plugin's sandboxed editor for the open file. It only exchanges the document with this tab. */
export default function PluginCustomEditorFrame({
  editor,
  fileId,
  content,
  readOnly,
  onContentChange,
  onSave,
  onDirtyHint,
  binaryDocument,
  onBytesChange
}: PluginCustomEditorFrameProps): React.JSX.Element {
  const t = useTranslate()
  const [refusal, setRefusal] = useState<CustomEditorEditRefusal | null>(null)
  const [saveBlocked, setSaveBlocked] = useState(false)
  const frameRef = useRef<PluginFrameElement | null>(null)
  // Why random: window.name is readable inside the frame, so it must not carry the file's path.
  const [frameName] = useState(
    () => `${PLUGIN_PANEL_FRAME_NAME_PREFIX}editor:${createBrowserUuid()}`
  )
  // Why refs: the host is built once per frame; props change on every keystroke.
  const latestRef = useRef({
    content,
    readOnly,
    onContentChange,
    onSave,
    onDirtyHint,
    binaryDocument,
    onBytesChange
  })
  useLayoutEffect(() => {
    latestRef.current = {
      content,
      readOnly,
      onContentChange,
      onSave,
      onDirtyHint,
      binaryDocument,
      onBytesChange
    }
  })
  const isBinary = binaryDocument !== undefined
  // Why code units for text: a byte count would re-encode the whole document on every edit.
  const isLarge =
    (binaryDocument?.bytes.byteLength ?? content.length) > CUSTOM_EDITOR_LARGE_DOCUMENT_BYTES

  const {
    entry: liveEntry,
    markUnresponsive,
    remountGone
  } = usePluginFrameEntry('editor', editor.pluginKey, editor.id)
  const progressRef = useRef<(step: 'delivered' | 'subscribed') => void>(() => {})
  const mergingRef = useRef<(merging: boolean) => void>(() => {})
  const countedRef = useRef(false)

  const host = useMemo(() => {
    const created = createCustomEditorHost({
      getFrameWindow: () => pluginFrameWindowOf(frameRef.current),
      getDocument: () => ({
        text: latestRef.current.content,
        readOnly: latestRef.current.readOnly
      }),
      ...(isBinary ? { getBinaryDocument: () => latestRef.current.binaryDocument ?? null } : {}),
      onEdit: (text) => {
        setRefusal(null)
        setSaveBlocked(false)
        latestRef.current.onContentChange(text)
      },
      onBytesEdit: (document) => {
        setRefusal(null)
        setSaveBlocked(false)
        latestRef.current.onBytesChange?.(document)
      },
      onEditRefused: setRefusal,
      onUnappliedEdit: (state) => {
        if (state !== null) {
          latestRef.current.onDirtyHint?.(true)
        }
      },
      onFrameProgress: (step) => progressRef.current(step),
      onMergesOutside: () => mergingRef.current(true),
      onKeyChord: (chord, context) => {
        const event = new KeyboardEvent('keydown', chord)
        // Why: chords are posted by frame code, so only one riding real user input may save.
        if (
          latestRef.current.readOnly ||
          !context.userActivation ||
          !editorShortcutMatches('editor.save', event)
        ) {
          return
        }
        // The save pipeline flushes this frame first; see registerEditorFrameFlush below.
        void latestRef.current.onSave(created.currentText())
      }
    })
    return created
  }, [isBinary])

  const entry = useCustomEditorReloadFlush(liveEntry, host.flush)
  const { captureLoad, captureSize } = usePluginEditorCaptureView(fileId)
  const frameKey =
    entry.status === 'ready' ? `${editor.key}:${entry.revision}:${captureLoad}` : null
  const guest = usablePluginFrameGuest(entry.status === 'ready' ? entry.guest : undefined)
  const entryHtml = entry.status === 'ready' && !guest ? entry.html : null
  // Why memoized: a new srcdoc reloads the frame; theme changes arrive as messages instead.
  const frameDocument = useMemo(
    () => (entryHtml === null ? null : fillPluginPanelShell(entryHtml)),
    [entryHtml]
  )

  const reportProgress = usePluginEditorCaptureReport(
    fileId,
    entry.status,
    guest?.url ?? null,
    frameKey
  )
  useLayoutEffect(() => {
    progressRef.current = reportProgress
    // Counts this view once while its session merges; text editors only.
    mergingRef.current = (merging) => {
      if (fileId !== undefined && !isBinary && merging !== countedRef.current) {
        countedRef.current = merging
        countCustomEditorMergingView(fileId, merging ? 1 : -1)
      }
    }
  })
  useCustomEditorOutsideMerge(isBinary ? undefined : fileId, host, content)

  const { onFrameLoad } = usePluginFrameHost({
    surface: 'editor',
    frameRef,
    frameKey,
    sessionToken: entry.status === 'ready' ? entry.sessionToken : null,
    editor: host.channel,
    onUnresponsive: markUnresponsive,
    onGuestGone: () => {
      // A dead guest cannot answer the reload's flush.
      host.reset()
      remountGone()
    }
  })

  useEffect(() => {
    if (!frameKey) {
      return
    }
    return () => {
      host.reset()
      mergingRef.current(false)
    }
  }, [frameKey, host])

  useEffect(() => {
    host.syncDocument()
  }, [content, readOnly, binaryDocument, host])

  useEffect(() => {
    if (fileId === undefined) {
      return
    }
    return registerEditorFrameFlush(fileId, async () => {
      const flushed = await host.flush()
      setSaveBlocked(!flushed)
      return flushed
    })
  }, [fileId, host])

  if (entry.status === 'loading') {
    return (
      <FrameMessage>
        {t('auto.components.editor.PluginCustomEditorFrame.loading', 'Loading editor…')}
      </FrameMessage>
    )
  }
  if (entry.status === 'unresponsive') {
    return (
      <FrameMessage>
        {t(
          'auto.components.editor.PluginCustomEditorFrame.unresponsive',
          '{{value0}} stopped responding. Switch to Source to keep editing.',
          { value0: editor.title }
        )}
      </FrameMessage>
    )
  }
  // An isolated-only editor never runs in the srcdoc fallback main hands back without a guest.
  if (entry.status === 'ready' && !guest && editor.frame === 'isolated') {
    return (
      <PluginEditorNeedsDesktopNotice
        title={editor.title}
        onOpenSource={
          fileId === undefined
            ? undefined
            : () => useCustomEditorViewStore.getState().setChoice(fileId, 'source')
        }
      />
    )
  }
  if (entry.status === 'error') {
    return (
      <FrameMessage>
        {t(
          'auto.components.editor.PluginCustomEditorFrame.loadFailed',
          '{{value0}} could not be loaded. Switch to Source to edit this file.',
          { value0: editor.title }
        )}
      </FrameMessage>
    )
  }
  return (
    <div
      className="flex h-full min-h-0 flex-col"
      style={captureSize ?? undefined}
      data-plugin-editor-surface={fileId}
    >
      {saveBlocked ? (
        <div className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {t(
            'auto.components.editor.PluginCustomEditorFrame.saveBlocked',
            "Couldn't save the latest changes from {{value0}}.",
            { value0: editor.title }
          )}
        </div>
      ) : refusal ? (
        <div className="border-b border-border px-3 py-1.5 text-xs text-destructive">
          {refusal === 'oversized'
            ? t(
                'auto.components.editor.PluginCustomEditorFrame.editTooLarge',
                'This file is too large for {{value0}} to save changes. Use Source instead.',
                { value0: editor.title }
              )
            : t(
                'auto.components.editor.PluginCustomEditorFrame.editsHeld',
                '{{value0}} is sending changes too quickly; Orca applies the latest one shortly.',
                { value0: editor.title }
              )}
        </div>
      ) : isLarge ? (
        <div className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {t(
            'auto.components.editor.PluginCustomEditorFrame.largeFile',
            'Large file — may take a moment.'
          )}
        </div>
      ) : null}
      <PluginFrameView
        key={frameKey}
        frameRef={frameRef}
        guest={guest}
        name={frameName}
        srcDoc={frameDocument ?? ''}
        onLoad={onFrameLoad}
        title={editor.title}
      />
    </div>
  )
}
