import { useState, type JSX } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { FileTypeIcon } from '@/components/icons/FileTypeIcon'
import {
  getCommonNewFileTypes,
  normalizeNewFileExtension,
  type NewFileExtensionPickerRequest,
  type NewFileExtensionSelection
} from '@/lib/editor/file-operations/new-file-extension-picker-request'
import { useTranslate } from '@/i18n/use-translate'

export function NewFileExtensionPickerDialog({
  activeRequest,
  resolveRequest
}: {
  activeRequest: NewFileExtensionPickerRequest | null
  resolveRequest: (selection: NewFileExtensionSelection) => void
}): JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [seenRequestId, setSeenRequestId] = useState<string | null>(null)
  if (activeRequest && activeRequest.id !== seenRequestId) {
    setSeenRequestId(activeRequest.id)
    setQuery('')
  }

  const trimmed = query.trim()
  const lower = trimmed.toLowerCase()
  const normalizedCustom = normalizeNewFileExtension(trimmed)
  const presets = getCommonNewFileTypes(t)
  const matchingPresets = trimmed
    ? presets.filter(
        (item) =>
          item.extension.toLowerCase().includes(lower) || item.label.toLowerCase().includes(lower)
      )
    : presets
  const showCustomItem =
    normalizedCustom !== null &&
    !matchingPresets.some((item) => item.extension.toLowerCase() === normalizedCustom.toLowerCase())

  return (
    <CommandDialog
      open={activeRequest !== null}
      onOpenChange={(open) => {
        if (!open) {
          resolveRequest({ type: 'cancel' })
        }
      }}
      shouldFilter={false}
      title={t('components.editor.newFileExtensionPicker.title', 'New File')}
      description={t(
        'components.editor.newFileExtensionPicker.description',
        'Choose or type a file extension.'
      )}
      contentClassName="w-[460px]"
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t(
          'components.editor.newFileExtensionPicker.placeholder',
          'Type an extension (e.g. ts, js, py)...'
        )}
      />
      <CommandList>
        <CommandEmpty>
          {t(
            'components.editor.newFileExtensionPicker.invalidExtension',
            'Enter a valid file extension (e.g. ts, .py, d.ts).'
          )}
        </CommandEmpty>
        {showCustomItem ? (
          <CommandGroup
            heading={t('components.editor.newFileExtensionPicker.customHeading', 'Custom')}
          >
            <CommandItem
              value={`custom:${normalizedCustom}`}
              onSelect={() => resolveRequest({ type: 'extension', extension: normalizedCustom })}
            >
              <FileTypeIcon
                filePath={`untitled${normalizedCustom}`}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">
                {t(
                  'components.editor.newFileExtensionPicker.createCustom',
                  'Create untitled{{extension}}',
                  { extension: normalizedCustom }
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">{normalizedCustom}</span>
            </CommandItem>
          </CommandGroup>
        ) : null}
        {matchingPresets.length > 0 ? (
          <CommandGroup
            heading={t('components.editor.newFileExtensionPicker.fileTypesHeading', 'File Types')}
          >
            {matchingPresets.map((item) => (
              <CommandItem
                key={item.extension}
                value={item.extension}
                onSelect={() => resolveRequest({ type: 'extension', extension: item.extension })}
              >
                <FileTypeIcon
                  filePath={`untitled${item.extension}`}
                  className="size-4 shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.label}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{item.extension}</span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}
      </CommandList>
    </CommandDialog>
  )
}
