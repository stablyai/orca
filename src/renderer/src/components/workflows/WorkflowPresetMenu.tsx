import { ChevronDown, Copy, Download, FilePlus2, Trash2, Upload } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { isWorkflowDraftDirty, useWorkflowEditorStore } from './workflow-editor-store'
import type { WorkflowPresetControls } from './use-workflow-presets'

export function WorkflowPresetMenu({ controls }: { controls: WorkflowPresetControls }) {
  const preset = useWorkflowEditorStore((state) => state.preset)
  const dirty = useWorkflowEditorStore(isWorkflowDraftDirty)
  const templates = controls.presets.filter((entry) => entry.template)
  const saved = controls.presets.filter((entry) => !entry.template)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="max-w-72">
          <span className="truncate text-[13px] font-semibold">
            {preset?.name ??
              translate('auto.components.workflows.WorkflowToolbar.ce6e56566a', 'Workflows')}
          </span>
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem onSelect={() => void controls.createNew()}>
          <FilePlus2 />
          {translate('auto.components.workflows.WorkflowToolbar.917a42fbbe', 'New workflow')}
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            {translate('auto.components.workflows.WorkflowToolbar.367e2bb776', 'Templates')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60">
            {templates.map((entry) => (
              <DropdownMenuItem key={entry.id} onSelect={() => void controls.open(entry)}>
                {entry.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {saved.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {translate('auto.components.workflows.WorkflowToolbar.c5bb6c6062', 'Saved')}
            </DropdownMenuLabel>
            {saved.map((entry) => (
              <DropdownMenuItem
                key={entry.id}
                onSelect={() => void controls.open(entry)}
                data-current={entry.id === preset?.id || undefined}
              >
                <span className="truncate">{entry.name}</span>
              </DropdownMenuItem>
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void controls.saveAs()}>
          <Copy />
          {translate('auto.components.workflows.WorkflowToolbar.b6981859e5', 'Save as copy')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void controls.importFile()}>
          <Upload />
          {translate('auto.components.workflows.WorkflowToolbar.1adb6e9f0a', 'Import…')}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void controls.exportFile()}>
          <Download />
          {translate('auto.components.workflows.WorkflowToolbar.c253dad02e', 'Export…')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={!preset || preset.template}
          onSelect={() => void controls.remove()}
        >
          <Trash2 />
          {translate('auto.components.workflows.WorkflowToolbar.baf1484c3b', 'Delete preset')}
        </DropdownMenuItem>
      </DropdownMenuContent>
      <span className="hidden text-2xs text-muted-foreground 2xl:inline">
        {preset?.template
          ? translate(
              'auto.components.workflows.WorkflowToolbar.fa102ef542',
              'Template · saving makes a copy'
            )
          : dirty
            ? translate('auto.components.workflows.WorkflowToolbar.920830ea69', 'Unsaved changes')
            : translate('auto.components.workflows.WorkflowToolbar.c5bb6c6062', 'Saved')}
      </span>
    </DropdownMenu>
  )
}
