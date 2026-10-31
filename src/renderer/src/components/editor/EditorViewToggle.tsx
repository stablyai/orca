import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  Code,
  Eye,
  FileText,
  GitCompareArrows,
  NotebookText,
  Pencil,
  PenTool,
  Table as TableIcon,
  type LucideIcon
} from 'lucide-react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { MarkdownViewMode } from '@/store/slices/editor'
import { translate } from '@/i18n/i18n'
import { PluginContributionIcon } from '@/components/plugins/PluginContributionIcon'

// Combine markdown modes with orthogonal edit/changes state in one mutually exclusive toggle; edit is the non-markdown source counterpart.
type BuiltInEditorToggleValue = MarkdownViewMode | 'edit' | 'changes'
/** A plugin custom editor, by its `<pluginKey>/<editorId>` key. */
export type CustomEditorToggleValue = `plugin-editor:${string}`
export type EditorToggleValue = BuiltInEditorToggleValue | CustomEditorToggleValue

/** How a plugin editor presents in the toggle; all text is plugin-provided and rendered plain. */
export type CustomEditorToggleOption = { title: string; pluginName: string; iconUrl?: string }
export type CustomEditorToggleOptions = Readonly<
  Record<CustomEditorToggleValue, CustomEditorToggleOption>
>

type ViewModeMetadata = { label: string; icon: LucideIcon; title?: string }

const DEFAULT_VIEW_MODE_METADATA: Record<BuiltInEditorToggleValue, ViewModeMetadata> = {
  source: {
    get label() {
      return translate('auto.components.editor.EditorViewToggle.4d6ccb7ba6', 'Source')
    },
    icon: Code
  },
  rich: {
    get label() {
      return translate('auto.components.editor.EditorViewToggle.aff15f94f5', 'Rich Editor')
    },
    icon: Pencil
  },
  preview: {
    get label() {
      return translate('auto.components.editor.EditorViewToggle.0d193dc03c', 'Preview')
    },
    icon: Eye
  },
  edit: {
    get label() {
      return translate('auto.components.editor.EditorViewToggle.ac3bb87913', 'Edit')
    },
    icon: FileText
  },
  changes: {
    get label() {
      return translate('auto.components.editor.EditorViewToggle.4837f3f578', 'Changes')
    },
    icon: GitCompareArrows,
    // Disambiguate uncommitted HEAD changes from the sidebar’s branch-base diff.
    get title() {
      return translate('auto.components.editor.EditorViewToggle.167f45888c', 'Uncommitted changes')
    }
  }
}

export const CSV_VIEW_MODE_METADATA: Partial<Record<MarkdownViewMode, ViewModeMetadata>> = {
  rich: {
    get label() {
      return translate('auto.components.editor.EditorViewToggle.e408aa9cd5', 'Table')
    },
    icon: TableIcon
  }
}

export const NOTEBOOK_VIEW_MODE_METADATA: Partial<Record<MarkdownViewMode, ViewModeMetadata>> = {
  rich: {
    get label() {
      return translate('auto.components.editor.EditorViewToggle.b3410cd5e0', 'Notebook')
    },
    icon: NotebookText
  }
}

/** With custom editors, plain-file editing is the file's Source. */
export const CUSTOM_EDITOR_SOURCE_METADATA: Partial<Record<'edit', ViewModeMetadata>> = {
  edit: DEFAULT_VIEW_MODE_METADATA.source
}

type EditorViewToggleProps = {
  value: EditorToggleValue
  modes: readonly EditorToggleValue[]
  onChange: (value: EditorToggleValue) => void
  metadataOverride?: Partial<Record<MarkdownViewMode | 'edit', ViewModeMetadata>>
  /** The file's plugin editors, by toggle value. */
  customEditorOptions?: CustomEditorToggleOptions
}

export function isCustomEditorToggleValue(
  value: EditorToggleValue
): value is CustomEditorToggleValue {
  return value.startsWith('plugin-editor:')
}

function viewModeMetadata(
  viewMode: BuiltInEditorToggleValue,
  metadataOverride: EditorViewToggleProps['metadataOverride']
): ViewModeMetadata {
  // Changes keeps its default metadata; markdown modes and Source accept presentation overrides.
  const override = viewMode === 'changes' ? undefined : metadataOverride?.[viewMode]
  return override ?? DEFAULT_VIEW_MODE_METADATA[viewMode]
}

type TogglePresentation = { label: string; tooltip: string; content: React.ReactNode }

function togglePresentation(
  viewMode: EditorToggleValue,
  metadataOverride: EditorViewToggleProps['metadataOverride'],
  customEditorOptions: EditorViewToggleProps['customEditorOptions']
): TogglePresentation {
  if (!isCustomEditorToggleValue(viewMode)) {
    const metadata = viewModeMetadata(viewMode, metadataOverride)
    const Icon = metadata.icon
    return {
      label: metadata.label,
      tooltip: metadata.title ?? metadata.label,
      content: <Icon className="size-3.5" />
    }
  }
  const option = customEditorOptions?.[viewMode]
  const title = option?.title ?? viewMode
  // Why named: an icon-only plugin view read as a built-in and went unnoticed; the cap keeps a long title from crowding the header.
  return {
    label: title,
    tooltip: option?.pluginName
      ? translate(
          'auto.components.editor.EditorViewToggle.pluginViewTooltip',
          '{{title}} (plugin view from {{plugin}})',
          { title, plugin: option.pluginName }
        )
      : title,
    content: (
      <>
        <PluginContributionIcon url={option?.iconUrl} fallback={PenTool} className="size-3.5" />
        <span data-plugin-editor-label="" className="max-w-24 truncate text-xs">
          {title}
        </span>
      </>
    )
  }
}

export default function EditorViewToggle({
  value,
  modes,
  onChange,
  metadataOverride,
  customEditorOptions
}: EditorViewToggleProps): React.JSX.Element {
  // Metadata uses getters; subscribe here so language changes repaint labels.
  useTranslation()
  return (
    <TooltipProvider delayDuration={300}>
      <ToggleGroup
        type="single"
        size="sm"
        className="h-[23px] [&_[data-slot=toggle-group-item]]:h-[23px] [&_[data-slot=toggle-group-item]]:min-w-[24px] [&_[data-slot=toggle-group-item]]:px-2"
        variant="outline"
        value={value}
        onValueChange={(v) => {
          if (v) {
            onChange(v as EditorToggleValue)
          }
        }}
      >
        {modes.map((viewMode) => {
          const presentation = togglePresentation(viewMode, metadataOverride, customEditorOptions)
          return (
            <Tooltip key={viewMode}>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value={viewMode}
                  aria-label={presentation.label}
                  className="h-[23px] min-w-[24px] px-2 aria-[checked=true]:border-foreground/20 aria-[checked=true]:bg-foreground/10 aria-[checked=true]:text-foreground aria-[checked=true]:shadow-xs aria-[checked=true]:hover:bg-foreground/15 aria-[checked=true]:hover:text-foreground data-[state=on]:border-foreground/20 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:hover:bg-foreground/15 data-[state=on]:hover:text-foreground"
                >
                  {presentation.content}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {presentation.tooltip}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </ToggleGroup>
    </TooltipProvider>
  )
}
