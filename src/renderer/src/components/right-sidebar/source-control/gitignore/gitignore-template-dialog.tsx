import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import type {
  GitignoreTemplateCatalogResult,
  GitignoreTemplateResult
} from '../../../../../../shared/gitignore-templates'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'

type GitignoreTemplateDialogProps = {
  open: boolean
  existingContent: string | null
  onOpenChange(open: boolean): void
  listTemplates(): Promise<GitignoreTemplateCatalogResult>
  getTemplate(name: string): Promise<GitignoreTemplateResult>
  onConfirm(content: string, mode: 'create' | 'append'): Promise<void>
}

function appendPreview(existingContent: string, templateContent: string): string {
  const separator = existingContent.length > 0 && !existingContent.endsWith('\n') ? '\n' : ''
  const blankLine = existingContent.length > 0 ? '\n' : ''
  return `${existingContent}${separator}${blankLine}${templateContent}`
}

export function GitignoreTemplateDialog({
  open,
  existingContent,
  onOpenChange,
  listTemplates,
  getTemplate,
  onConfirm
}: GitignoreTemplateDialogProps): React.JSX.Element {
  const [catalog, setCatalog] = useState<GitignoreTemplateCatalogResult | null>(null)
  const [selected, setSelected] = useState<GitignoreTemplateResult | null>(null)
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void listTemplates()
      .then((result) => {
        if (!cancelled) {
          setCatalog(result)
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : 'Could not load templates.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [listTemplates, open])

  const filteredTemplates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return (catalog?.templates ?? []).filter((template) =>
      template.name.toLocaleLowerCase().includes(normalized)
    )
  }, [catalog, query])
  const mode = existingContent === null ? 'create' : 'append'
  const preview = selected
    ? mode === 'append'
      ? appendPreview(existingContent ?? '', selected.content)
      : selected.content
    : ''

  const selectTemplate = async (name: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setSelected(await getTemplate(name))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load the template.')
    } finally {
      setLoading(false)
    }
  }

  const confirm = async (): Promise<void> => {
    if (!selected) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      await onConfirm(preview, mode)
      onOpenChange(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save .gitignore.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Create .gitignore' : 'Append to .gitignore'}</DialogTitle>
          <DialogDescription>
            {mode === 'create'
              ? 'Choose a template from github/gitignore and review it before creating the file.'
              : 'The existing file will not be overwritten. Review the combined content before appending.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
          <div className="min-w-0 rounded-md border border-border">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search templates"
              aria-label="Search gitignore templates"
              className="rounded-b-none border-0 border-b shadow-none"
            />
            <ScrollArea className="h-80">
              <div className="p-1">
                {filteredTemplates.map((template) => (
                  <button
                    key={template.name}
                    type="button"
                    onClick={() => void selectTemplate(template.name)}
                    aria-pressed={selected?.template.name === template.name}
                    className="w-full rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-pressed:bg-accent"
                  >
                    {template.name}
                  </button>
                ))}
                {!loading && filteredTemplates.length === 0 && (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">No templates found</p>
                )}
              </div>
            </ScrollArea>
          </div>

          <div className="min-w-0 rounded-md border border-border bg-muted/20">
            <div className="flex h-9 items-center border-b border-border px-3 text-xs text-muted-foreground">
              {selected?.template.filename ?? 'Template preview'}
              {(catalog?.stale || selected?.stale) && <span className="ml-auto">Offline cache</span>}
            </div>
            <ScrollArea className="h-80">
              <pre className="min-h-80 whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed">
                {loading && !selected ? 'Loading...' : preview || 'Select a template to preview it.'}
              </pre>
            </ScrollArea>
          </div>
        </div>

        {error && (
          <div role="alert" className="flex items-start gap-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void confirm()} disabled={!selected || loading || saving}>
            {saving && <Loader2 className="animate-spin" />}
            {mode === 'create' ? 'Create file' : 'Append changes'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { appendPreview }
