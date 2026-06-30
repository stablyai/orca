import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import { Bot, Copy, FilePlus, FolderOpen, Save, Search, Trash2 } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { Button } from '../ui/button'
import type {
  ArchitectureProjectModelEntry,
  ArchitectureTemplateEntry
} from './useArchitectureModelController'

type ArchitectureCommandPaletteProps = {
  open: boolean
  activeModelName: string
  models: ArchitectureProjectModelEntry[]
  templates: ArchitectureTemplateEntry[]
  disabled: boolean
  onOpenChange: (open: boolean) => void
  onCreateBlank: (modelName: string) => void | Promise<void>
  onOpenModel: (
    modelName: string,
    scope: ArchitectureProjectModelEntry['scope']
  ) => void | Promise<void>
  onSaveAs: (modelName: string) => void | Promise<void>
  onDeleteModel: (modelName: string) => void | Promise<void>
  onLoadTemplate: (templateId: string, modelName: string) => void | Promise<void>
}

export function ArchitectureCommandPalette({
  open,
  activeModelName,
  models,
  templates,
  disabled,
  onOpenChange,
  onCreateBlank,
  onOpenModel,
  onSaveAs,
  onDeleteModel,
  onLoadTemplate
}: ArchitectureCommandPaletteProps): React.JSX.Element {
  const [modelName, setModelName] = useState('')
  const runningRef = useRef(false)

  useEffect(() => {
    if (open) {
      setModelName('')
    }
  }, [open])

  const name = modelName.trim()
  const fallbackSaveName = name || `${activeModelName}-copy`

  const run = async (action: () => void | Promise<void>): Promise<void> => {
    if (disabled || runningRef.current) {
      return
    }
    runningRef.current = true
    try {
      await action()
      onOpenChange(false)
    } finally {
      runningRef.current = false
    }
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content className="fixed left-[50%] top-[20%] z-50 w-[720px] max-w-[90vw] translate-x-[-50%] rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95">
          <DialogPrimitive.Title className="sr-only">Architecture Commands</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Manage architecture models and templates
          </DialogPrimitive.Description>
          <div className="flex items-center border-b border-border px-3">
            <Search className="mr-2 size-4 shrink-0 opacity-50" />
            <input
              className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="Type a model name, or choose an architecture command..."
              value={modelName}
              onChange={(event) => setModelName(event.currentTarget.value)}
              data-testid="architecture-command-input"
            />
          </div>
          <div
            className="scrollbar-sleek max-h-[min(400px,60vh)] overflow-y-auto overflow-x-hidden p-1"
            data-testid="architecture-command-palette"
          >
            <CommandSection heading="Model">
              <PaletteActionButton
                onClick={() => void run(() => onCreateBlank(name || 'model'))}
                disabled={disabled}
                data-testid="architecture-command-new"
              >
                <FilePlus className="size-4" />
                <span className="min-w-0 flex-1">New blank model</span>
                <span className="font-mono text-xs text-muted-foreground">{name || 'model'}</span>
              </PaletteActionButton>
              <PaletteActionButton
                onClick={() => void run(() => onSaveAs(fallbackSaveName))}
                disabled={disabled}
                data-testid="architecture-command-save-as"
              >
                <Save className="size-4" />
                <span className="min-w-0 flex-1">Save current model as</span>
                <span className="font-mono text-xs text-muted-foreground">{fallbackSaveName}</span>
              </PaletteActionButton>
            </CommandSection>

            <CommandSection heading="Open Existing">
              {models.length === 0 ? (
                <div className="px-3 py-2 text-xs text-muted-foreground">No saved models yet</div>
              ) : (
                models.map((model) => (
                  <div
                    key={model.name}
                    className="flex items-center gap-1 rounded-sm px-1 py-1"
                    data-testid="architecture-command-model-row"
                  >
                    <PaletteActionButton
                      className="min-w-0 flex-1"
                      onClick={() => void run(() => onOpenModel(model.name, model.scope))}
                      disabled={disabled}
                      data-testid="architecture-command-open-model"
                    >
                      <FolderOpen className="size-4" />
                      <span className="min-w-0 flex-1 truncate text-left">{model.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {model.scope === 'global' ? 'global' : 'project'}
                      </span>
                      {model.name === activeModelName ? (
                        <span className="text-xs text-muted-foreground">current</span>
                      ) : null}
                    </PaletteActionButton>
                    {model.scope === 'project' ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="text-muted-foreground hover:text-destructive"
                        data-testid="architecture-command-delete-model"
                        disabled={disabled}
                        onClick={(event) => {
                          event.stopPropagation()
                          void run(() => onDeleteModel(model.name))
                        }}
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    ) : null}
                  </div>
                ))
              )}
            </CommandSection>

            <CommandSection heading="Templates">
              {templates.map((template) => {
                const templateModelName = name || template.id
                return (
                  <PaletteActionButton
                    key={template.id}
                    onClick={() => void run(() => onLoadTemplate(template.id, templateModelName))}
                    disabled={disabled}
                    data-testid="architecture-command-template"
                  >
                    <Copy className="size-4" />
                    <span className="min-w-0 flex-1">{template.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {templateModelName}
                    </span>
                  </PaletteActionButton>
                )
              })}
            </CommandSection>

            <CommandSection heading="AI">
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Bot className="size-3.5" />
                Build with AI and Fill with AI appear directly on empty architecture views.
              </div>
            </CommandSection>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}

function CommandSection({
  heading,
  children
}: {
  heading: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="grid gap-1 p-1">
      <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{heading}</div>
      {children}
    </section>
  )
}

function PaletteActionButton({
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>): React.JSX.Element {
  return (
    <button
      type="button"
      className={`relative flex w-full cursor-default select-none items-center gap-2 rounded-sm px-2 py-2 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50 ${className}`}
      {...props}
    />
  )
}
