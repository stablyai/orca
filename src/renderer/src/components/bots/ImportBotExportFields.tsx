// "Another app…": two steps. Copy the message that asks the old bot to copy its own files to Downloads, then
// give the new bot that folder (dropped or chosen), and the old bot's reply if it wrote one.
import React, { useState } from 'react'
import { Check, ChevronDown, File, Folder, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Textarea } from '@/components/ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import { getRuntimePathBasename } from '../../../../shared/file-access/cross-platform-path'
import { BOT_IMPORT_EXPORT_PROMPT, BOT_IMPORT_REPLY_MAX } from '../../../../shared/bots/bot-import'

export type ImportBotExport = { folder: string | null; files: string[]; reply: string }

/** The folder and files the new bot reads: the folder first, or the first file when only files were dropped. */
export function exportImportPaths(
  value: ImportBotExport
): { path: string; files: string[] } | null {
  const [first, ...rest] = value.folder ? [value.folder, ...value.files] : value.files
  return first ? { path: first, files: rest } : null
}

function droppedPaths(event: React.DragEvent): string[] {
  const getPath = window.api.fs.getPathForFile
  if (!getPath) {
    return []
  }
  return [...event.dataTransfer.files].map((file) => getPath(file)).filter(Boolean)
}

function Step({
  n,
  done,
  title,
  action,
  children
}: {
  n: number
  done: boolean
  title: string
  action?: React.ReactNode
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex gap-2.5">
      <span
        data-done={done || undefined}
        className="mt-1.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-border text-2xs font-semibold text-muted-foreground data-[done]:border-primary data-[done]:bg-primary data-[done]:text-primary-foreground"
      >
        {done ? <Check className="size-3" strokeWidth={3} /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex min-h-8 items-center justify-between gap-2">
          <span className="text-sm font-medium">{title}</span>
          {action}
        </div>
        {children}
      </div>
    </li>
  )
}

function PathChip({
  path,
  folder,
  onRemove
}: {
  path: string
  folder: boolean
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const Icon = folder ? Folder : File
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border py-1 pr-1 pl-2.5 text-xs">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate" title={path}>
        {path}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('bots.import.removePath', 'Remove {{name}}', {
          name: getRuntimePathBasename(path)
        })}
        onClick={onRemove}
      >
        <X />
      </Button>
    </div>
  )
}

export function ImportBotExportFields({
  value,
  onChange
}: {
  value: ImportBotExport
  onChange: (value: ImportBotExport) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [copied, setCopied] = useState(false)
  const [dragging, setDragging] = useState(false)
  const pick = async (): Promise<void> => {
    try {
      const folder = await window.api.repos.pickFolder()
      if (folder) {
        onChange({ ...value, folder })
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const chosen = exportImportPaths(value) !== null
  return (
    <ol className="space-y-2.5">
      <Step
        n={1}
        done={copied}
        title={t('bots.import.sendStep', 'Send your old bot this message')}
        action={
          <Button
            type="button"
            variant={copied ? 'ghost' : 'outline'}
            size="xs"
            onClick={() => {
              // The main process's clipboard: it takes the text even when the window lacks focus.
              void window.api.ui.writeClipboardText(BOT_IMPORT_EXPORT_PROMPT).then(
                () => setCopied(true),
                (error: unknown) =>
                  toast.error(error instanceof Error ? error.message : String(error))
              )
            }}
          >
            {copied
              ? t('bots.import.copied', 'Copied')
              : t('bots.import.copyMessage', 'Copy message')}
          </Button>
        }
      >
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="disclosure" size="xs" className="group -ml-2">
              {t('bots.import.seeMessage', 'See the message')}
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent animation="height">
            <p className="mt-1.5 rounded-lg border border-border px-2.5 py-2 text-xs text-muted-foreground select-text">
              {BOT_IMPORT_EXPORT_PROMPT}
            </p>
          </CollapsibleContent>
        </Collapsible>
      </Step>
      <Step n={2} done={chosen} title={t('bots.import.addStep', 'Add the folder it made')}>
        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const paths = droppedPaths(event)
            if (paths.length) {
              onChange({ ...value, files: [...new Set([...value.files, ...paths])] })
            }
          }}
          data-dragging={dragging || undefined}
          className="space-y-1.5 rounded-lg data-[dragging]:bg-accent"
        >
          {value.folder ? (
            <PathChip
              path={value.folder}
              folder
              onRemove={() => onChange({ ...value, folder: null })}
            />
          ) : null}
          {value.files.map((file) => (
            <PathChip
              key={file}
              path={file}
              folder={false}
              onRemove={() =>
                onChange({ ...value, files: value.files.filter((other) => other !== file) })
              }
            />
          ))}
          {chosen ? null : (
            <p className="rounded-lg border border-dashed border-input px-2.5 py-2.5 text-center text-xs text-muted-foreground">
              {t('bots.import.dropHint', 'Drop it here, or')}{' '}
              <Button type="button" variant="link" size="inlineText" onClick={() => void pick()}>
                {t('bots.import.chooseFolder', 'choose a folder…')}
              </Button>
            </p>
          )}
        </div>
        {chosen ? (
          <Textarea
            rows={3}
            maxLength={BOT_IMPORT_REPLY_MAX}
            value={value.reply}
            onChange={(event) => onChange({ ...value, reply: event.target.value })}
            aria-label={t('bots.import.replyLabel', 'Its reply')}
            placeholder={t('bots.import.replyPlaceholder', 'Paste its reply, if it wrote one')}
          />
        ) : null}
      </Step>
    </ol>
  )
}
