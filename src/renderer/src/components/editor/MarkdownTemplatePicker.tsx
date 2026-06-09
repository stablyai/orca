import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { FileText } from 'lucide-react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import type {
  MarkdownTemplatePickerRequest,
  MarkdownTemplateSelection
} from '@/lib/markdown-template-picker-request'
import { subscribeMarkdownTemplatePicker } from '@/lib/markdown-template-picker-request'
import { translate } from '@/i18n/i18n'

export function MarkdownTemplatePicker(): JSX.Element {
  const [activeRequest, setActiveRequest] = useState<MarkdownTemplatePickerRequest | null>(null)
  const activeRequestRef = useRef<MarkdownTemplatePickerRequest | null>(null)
  activeRequestRef.current = activeRequest

  const resolveRequest = useCallback((selection: MarkdownTemplateSelection): void => {
    const request = activeRequestRef.current
    if (!request) {
      return
    }

    activeRequestRef.current = null
    request.resolve(selection)
    setActiveRequest(null)
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeMarkdownTemplatePicker((request) => {
      activeRequestRef.current?.resolve({ type: 'cancel' })
      activeRequestRef.current = request
      setActiveRequest(request)
    })

    return () => {
      activeRequestRef.current?.resolve({ type: 'cancel' })
      activeRequestRef.current = null
      unsubscribe()
    }
  }, [])

  return (
    <CommandDialog
      open={activeRequest !== null}
      onOpenChange={(open) => {
        if (!open) {
          resolveRequest({ type: 'cancel' })
        }
      }}
      title={translate("auto.components.editor.MarkdownTemplatePicker.1829437fce", "New Markdown")}
      description={translate("auto.components.editor.MarkdownTemplatePicker.7b458e0b7f", "Choose a Markdown template.")}
      contentClassName="w-[520px]"
    >
      <CommandInput placeholder={translate("auto.components.editor.MarkdownTemplatePicker.22fd4890ad", "Search templates...")} />
      <CommandList>
        <CommandEmpty>{translate("auto.components.editor.MarkdownTemplatePicker.df667919ca", "No matching templates.")}</CommandEmpty>
        <CommandGroup heading="New Document">
          <CommandItem
            value="blank markdown document"
            className="items-start gap-3"
            onSelect={() => resolveRequest({ type: 'blank' })}
          >
            <FileText className="mt-0.5 size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{translate("auto.components.editor.MarkdownTemplatePicker.6e2e6c04ad", "Blank Markdown")}</span>
              <span className="block truncate text-xs text-muted-foreground">{translate("auto.components.editor.MarkdownTemplatePicker.22cd94426f", "untitled.md")}</span>
            </span>
          </CommandItem>
        </CommandGroup>
        {activeRequest && (
          <CommandGroup heading="Templates">
            {activeRequest.templates.map((template) => (
              <CommandItem
                key={template.id}
                value={`${template.name} ${template.templateRelativePath}`}
                className="items-start gap-3"
                onSelect={() => resolveRequest({ type: 'template', template })}
              >
                <FileText className="mt-0.5 size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{template.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {template.templateRelativePath}
                  </span>
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}
      </CommandList>
    </CommandDialog>
  )
}
