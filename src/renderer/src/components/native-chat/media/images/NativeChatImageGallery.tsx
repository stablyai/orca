import { useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getLocalImageCacheKey } from '@/components/editor/document-images/useLocalImageSrc'
import { PanZoomImageDialog } from '@/components/editor/PanZoomImageDialog'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatTurnRows } from '../../conversation/slots/use-native-chat-turn-membership'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { NativeChatImageGalleryContext } from './native-chat-image-gallery-context'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import {
  nativeChatGalleryGroup,
  nativeChatGalleryRecords,
  type NativeChatGalleryRecord
} from './native-chat-image-gallery-records'
import { useNativeChatReferenceImageSource } from './use-native-chat-reference-image-source'
import { useNativeChatMarkdownImageSource } from './use-native-chat-markdown-image-source'
import { copyableNativeChatImageSrc, keepPreviewOpenForChatMenu } from './native-chat-image-copy'
type ActiveGallery = {
  group: string
  selected: string
  snapshot: NativeChatGalleryRecord[]
  scope: string
  preview?: { id: string; src: string }
}
function ReferenceSource({
  record,
  runtime,
  onSource
}: {
  record: NativeChatGalleryRecord
  runtime: RuntimeFileOperationArgs | null | undefined
  onSource: (id: string, source: string | undefined) => void
}): null {
  const src = useNativeChatReferenceImageSource(record.block!, runtime, true)
  useEffect(() => {
    onSource(record.id, src)
    return () => onSource(record.id, undefined)
  }, [record.id, src, onSource])
  return null
}
function MarkdownSource({
  record,
  onSource
}: {
  record: NativeChatGalleryRecord
  onSource: (id: string, source: string | undefined) => void
}): null {
  const { imageSrc } = useNativeChatMarkdownImageSource(record.source, true)
  useEffect(() => {
    onSource(record.id, imageSrc)
    return () => onSource(record.id, undefined)
  }, [record.id, imageSrc, onSource])
  return null
}
type GalleryProps = {
  rows: NativeChatTurnRows
  visuals: boolean
  runtimeContext: RuntimeFileOperationArgs | null | undefined
  children: React.ReactNode
}
export function NativeChatImageGallery(props: GalleryProps): React.JSX.Element {
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const runtime = props.runtimeContext === undefined ? owner?.runtimeContext : props.runtimeContext
  const scope = `${runtime === null ? 'unresolved:' : ''}${getLocalImageCacheKey('', runtime?.connectionId, runtime ?? undefined)}`
  return <ScopedNativeChatImageGallery key={scope} {...props} />
}
function ScopedNativeChatImageGallery({
  rows,
  visuals,
  runtimeContext,
  children
}: {
  rows: NativeChatTurnRows
  visuals: boolean
  runtimeContext: RuntimeFileOperationArgs | null | undefined
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const owner = useContext(NativeChatMarkdownImageOwnerContext)
  const runtime = runtimeContext === undefined ? owner?.runtimeContext : runtimeContext
  const scope = `${runtime === null ? 'unresolved:' : ''}${getLocalImageCacheKey('', runtime?.connectionId, runtime ?? undefined)}`
  const [active, setActive] = useState<ActiveGallery | null>(null)
  const [sources, setSources] = useState<Record<string, string | undefined>>({})
  useEffect(() => {
    if (owner?.isVisible === false) {
      setActive(null)
    }
  }, [owner?.isVisible])
  const open = useCallback(
    (rowId: string, source: string, title: string, previewSrc?: string): void => {
      const index = rows.messages.findIndex((row) => row.id === rowId)
      if (index === -1) {
        return
      }
      const group = nativeChatGalleryGroup(rows, index)
      const records = nativeChatGalleryRecords(rows, group, visuals)
      let selected =
        records.find((record) => record.rowId === rowId && record.source === source) ??
        records.find((record) => record.source === source)
      if (!selected) {
        selected = { id: `clicked:${rowId}:${source}`, rowId, source, title, kind: 'markdown' }
        records.push(selected)
      }
      setSources({})
      setActive({
        group,
        selected: selected.id,
        snapshot: records,
        scope,
        ...(previewSrc ? { preview: { id: selected.id, src: previewSrc } } : {})
      })
    },
    [rows, visuals, scope]
  )
  const records = useMemo(() => {
    if (!active) {
      return []
    }
    const current = nativeChatGalleryRecords(rows, active.group, visuals)
    return current.some((record) => record.id === active.selected) ? current : active.snapshot
  }, [rows, active, visuals])
  const selectedIndex = records.findIndex((record) => record.id === active?.selected)
  const selected = records[selectedIndex]
  const onSource = useCallback(
    (id: string, source: string | undefined) =>
      setSources((previous) =>
        previous[id] === source ? previous : { ...previous, [id]: source }
      ),
    []
  )
  const value = useMemo(() => ({ open }), [open])
  return (
    <NativeChatImageGalleryContext.Provider value={value}>
      {children}
      {active &&
        records.map((record, index) =>
          Math.abs(index - selectedIndex) <= 9 ? (
            record.kind === 'reference' ? (
              <ReferenceSource
                key={record.id}
                record={record}
                runtime={runtimeContext === undefined ? owner?.runtimeContext : runtimeContext}
                onSource={onSource}
              />
            ) : (
              <MarkdownSource key={record.id} record={record} onSource={onSource} />
            )
          ) : null
        )}
      <PanZoomImageDialog
        open={!!selected}
        onOpenChange={(next) => {
          if (!next) {
            setActive(null)
          }
        }}
        src={
          selected &&
          (sources[selected.id] ??
            (active?.preview?.id === selected.id ? active.preview.src : undefined))
        }
        title={selected?.title ?? ''}
        showTitle
        gallery={records.map((record) => ({
          id: record.id,
          src: sources[record.id],
          title: record.title
        }))}
        selectedIndex={Math.max(0, selectedIndex)}
        onSelectImage={(index) => {
          const record = records[index]
          if (record) {
            setActive((current) => (current ? { ...current, selected: record.id } : null))
          }
        }}
        onInteractOutside={keepPreviewOpenForChatMenu}
        data-native-chat-copy-image-src={copyableNativeChatImageSrc(
          selected &&
            (sources[selected.id] ??
              (active?.preview?.id === selected.id ? active.preview.src : undefined))
        )}
        fallback={
          <span className="text-sm text-muted-foreground">
            {t('components.native-chat.composer.imageUnavailable', 'Preview unavailable')}
          </span>
        }
      />
    </NativeChatImageGalleryContext.Provider>
  )
}
