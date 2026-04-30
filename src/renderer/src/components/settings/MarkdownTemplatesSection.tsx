import { useEffect, useRef, useState } from 'react'
import { FileText, Pencil, Plus, Trash2 } from 'lucide-react'
import type { GlobalSettings, MarkdownDocumentTemplate } from '../../../../shared/types'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

type MarkdownTemplatesSectionProps = {
  templates: MarkdownDocumentTemplate[]
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

type TemplateDraft = {
  id: string | null
  name: string
  content: string
  createdAt: number | null
}

function createTemplateId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `template-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createEmptyDraft(): TemplateDraft {
  return {
    id: null,
    name: '',
    content: '',
    createdAt: null
  }
}

function draftFromTemplate(template: MarkdownDocumentTemplate): TemplateDraft {
  return {
    id: template.id,
    name: template.name,
    content: template.content,
    createdAt: template.createdAt
  }
}

const PLACEHOLDERS = [
  { token: '{{title}}', label: 'File title' },
  { token: '{{filename}}', label: 'Filename' },
  { token: '{{date}}', label: 'Local date' },
  { token: '{{time}}', label: 'Local time' },
  { token: '{{datetime}}', label: 'Date and time' }
] as const

export function MarkdownTemplatesSection({
  templates,
  updateSettings
}: MarkdownTemplatesSectionProps): React.JSX.Element {
  const [draft, setDraft] = useState<TemplateDraft | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<MarkdownDocumentTemplate | null>(null)
  const contentRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!draft?.id) {
      return
    }
    const latest = templates.find((template) => template.id === draft.id)
    if (!latest) {
      setDraft(null)
    }
  }, [draft?.id, templates])

  const openAddDialog = (): void => {
    setDraft(createEmptyDraft())
  }

  const openEditDialog = (template: MarkdownDocumentTemplate): void => {
    setDraft(draftFromTemplate(template))
  }

  const saveDraft = (): void => {
    if (!draft) {
      return
    }

    const now = Date.now()
    const name = draft.name.trim()
    if (!name) {
      return
    }

    const savedTemplate: MarkdownDocumentTemplate = {
      id: draft.id ?? createTemplateId(),
      name,
      content: draft.content,
      createdAt: draft.createdAt ?? now,
      updatedAt: now
    }

    const nextTemplates = draft.id
      ? templates.map((template) => (template.id === draft.id ? savedTemplate : template))
      : [...templates, savedTemplate]

    updateSettings({ markdownDocumentTemplates: nextTemplates })
    setDraft(null)
  }

  const confirmDelete = (): void => {
    if (!deleteTarget) {
      return
    }
    updateSettings({
      markdownDocumentTemplates: templates.filter((template) => template.id !== deleteTarget.id)
    })
    setDeleteTarget(null)
  }

  const insertPlaceholder = (token: string): void => {
    if (!draft) {
      return
    }
    const contentInput = contentRef.current
    const selectionStart = contentInput?.selectionStart ?? draft.content.length
    const selectionEnd = contentInput?.selectionEnd ?? draft.content.length
    const nextContent = `${draft.content.slice(0, selectionStart)}${token}${draft.content.slice(selectionEnd)}`
    setDraft({ ...draft, content: nextContent })
    window.requestAnimationFrame(() => {
      contentInput?.focus()
      const nextCursor = selectionStart + token.length
      contentInput?.setSelectionRange(nextCursor, nextCursor)
    })
  }

  const isSavingDisabled = !draft?.name.trim()

  return (
    <section className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Markdown Templates</h2>
          <p className="text-xs text-muted-foreground">
            Global templates available when creating Markdown documents.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={openAddDialog} className="shrink-0 gap-1.5">
          <Plus className="size-3.5" />
          Add
        </Button>
      </div>

      {templates.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/70 px-4 py-5 text-sm text-muted-foreground">
          No templates saved.
        </div>
      ) : (
        <div className="divide-y divide-border/50 rounded-md border border-border/50">
          {templates.map((template) => (
            <div key={template.id} className="flex items-center gap-3 px-3 py-2.5">
              <FileText className="size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{template.name}</div>
                <div className="truncate text-xs text-muted-foreground">
                  Updated {new Date(template.updatedAt).toLocaleDateString()}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => openEditDialog(template)}
                aria-label={`Edit ${template.name}`}
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setDeleteTarget(template)}
                aria-label={`Delete ${template.name}`}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!draft} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft?.id ? 'Edit Template' : 'Add Template'}</DialogTitle>
            <DialogDescription>
              Save a reusable Markdown body with supported placeholders.
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="markdown-template-name">Name</Label>
                <Input
                  id="markdown-template-name"
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  placeholder="Daily note"
                  autoFocus
                />
              </div>

              <div className="space-y-2">
                <div className="space-y-1">
                  <Label htmlFor="markdown-template-content">Template body</Label>
                  <p className="text-xs text-muted-foreground">
                    Write Markdown here. Insert placeholders where Orca should fill values for the
                    current file.
                  </p>
                </div>
                <textarea
                  id="markdown-template-content"
                  ref={contentRef}
                  value={draft.content}
                  onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                  className="min-h-60 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  placeholder={`# {{title}}\n\nCreated {{datetime}}\n\n`}
                  spellCheck={false}
                />
                <div className="rounded-md border border-border/60 bg-muted/20 p-3">
                  <div className="mb-2 text-xs font-medium text-foreground">
                    Insert placeholders
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {PLACEHOLDERS.map((placeholder) => (
                      <button
                        key={placeholder.token}
                        type="button"
                        className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border/60 bg-background/70 px-2.5 py-2 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => insertPlaceholder(placeholder.token)}
                      >
                        <code className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono">
                          {placeholder.token}
                        </code>
                        <span className="min-w-0 truncate text-muted-foreground">
                          {placeholder.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button onClick={saveDraft} disabled={isSavingDisabled}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Template</DialogTitle>
            <DialogDescription>
              Delete {deleteTarget ? `"${deleteTarget.name}"` : 'this template'}?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
