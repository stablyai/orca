import { useCallback, useEffect, useState } from 'react'
import { Terminal, Upload } from 'lucide-react'
import { toast } from 'sonner'
import type {
  CustomAgentDefinition,
  CustomAgentIcon,
  CustomAgentPromptMode
} from '../../../../shared/custom-agent'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Textarea } from '../ui/textarea'
import { translate } from '@/i18n/i18n'

type CustomAgentDialogProps = {
  open: boolean
  initialAgent?: CustomAgentDefinition
  onOpenChange: (open: boolean) => void
  onSave: (value: Omit<CustomAgentDefinition, 'id'>) => void
}

const defaultIcon: CustomAgentIcon = { kind: 'terminal' }

export function CustomAgentDialog({
  open,
  initialAgent,
  onOpenChange,
  onSave
}: CustomAgentDialogProps): React.JSX.Element {
  const [name, setName] = useState(initialAgent?.name ?? '')
  const [command, setCommand] = useState(initialAgent?.command ?? '')
  const [promptMode, setPromptMode] = useState<CustomAgentPromptMode>(initialAgent?.promptMode ?? 'pty')
  const [promptTemplate, setPromptTemplate] = useState(initialAgent?.promptTemplate ?? '')
  const [icon, setIcon] = useState<CustomAgentIcon>(initialAgent?.icon ?? defaultIcon)

  const resetFromProps = useCallback((): void => {
    setName(initialAgent?.name ?? '')
    setCommand(initialAgent?.command ?? '')
    setPromptMode(initialAgent?.promptMode ?? 'pty')
    setPromptTemplate(initialAgent?.promptTemplate ?? '')
    setIcon(initialAgent?.icon ?? defaultIcon)
  }, [initialAgent])

  useEffect(() => {
    resetFromProps()
  }, [open, resetFromProps])

  const save = (): void => {
    const trimmedName = name.trim()
    const trimmedCommand = command.trim()
    if (!trimmedName || !trimmedCommand) {
      toast.error(translate('auto.components.settings.CustomAgentDialog.required', 'Name and command are required.'))
      return
    }
    if (promptMode === 'template' && !promptTemplate.includes('{prompt}')) {
      toast.error(translate('auto.components.settings.CustomAgentDialog.promptPlaceholder', 'The template must include {prompt}.'))
      return
    }
    onSave({
      name: trimmedName,
      command: trimmedCommand,
      promptMode,
      ...(promptMode === 'template' ? { promptTemplate: promptTemplate.trim() } : {}),
      icon,
      enabled: initialAgent?.enabled ?? true
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) resetFromProps(); onOpenChange(next) }}>
      <DialogContent className="sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>
            {initialAgent
              ? translate('auto.components.settings.CustomAgentDialog.editTitle', 'Edit custom agent')
              : translate('auto.components.settings.CustomAgentDialog.createTitle', 'Create custom agent')}
          </DialogTitle>
          <DialogDescription>
            {translate('auto.components.settings.CustomAgentDialog.description', 'Configure a command Orca can launch in a terminal.')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-agent-name">{translate('auto.components.settings.CustomAgentDialog.name', 'Name')}</Label>
            <Input id="custom-agent-name" value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-agent-command">{translate('auto.components.settings.CustomAgentDialog.command', 'Command')}</Label>
            <Input id="custom-agent-command" value={command} onChange={(event) => setCommand(event.target.value)} spellCheck={false} className="font-mono" placeholder="my-agent --interactive" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="custom-agent-prompt-mode">{translate('auto.components.settings.CustomAgentDialog.promptMode', 'Prompt delivery')}</Label>
            <Select value={promptMode} onValueChange={(value) => setPromptMode(value as CustomAgentPromptMode)}>
              <SelectTrigger id="custom-agent-prompt-mode"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="pty">{translate('auto.components.settings.CustomAgentDialog.pty', 'Type into the terminal')}</SelectItem>
                <SelectItem value="argv">{translate('auto.components.settings.CustomAgentDialog.argv', 'Append as an argument')}</SelectItem>
                <SelectItem value="template">{translate('auto.components.settings.CustomAgentDialog.template', 'Use a command template')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {promptMode === 'template' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="custom-agent-template">{translate('auto.components.settings.CustomAgentDialog.templateLabel', 'Command template')}</Label>
              <Textarea id="custom-agent-template" value={promptTemplate} onChange={(event) => setPromptTemplate(event.target.value)} spellCheck={false} className="font-mono" placeholder="my-agent --prompt {prompt}" />
            </div>
          )}
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={async () => {
              try {
                const result = await window.api.shell.pickRepoIconImage()
                if (result) setIcon({ kind: 'image', dataUrl: result.dataUrl, fileName: result.fileName })
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Failed to import icon')
              }
            }}>
              <Upload data-icon="inline-start" />{translate('auto.components.settings.CustomAgentDialog.uploadIcon', 'Choose PNG icon')}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setIcon(defaultIcon)}>
              <Terminal data-icon="inline-start" />{translate('auto.components.settings.CustomAgentDialog.terminalIcon', 'Use terminal icon')}
            </Button>
            {icon.kind === 'image' && <img src={icon.dataUrl} alt="" aria-hidden className="size-7 rounded" />}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{translate('auto.components.settings.CustomAgentDialog.cancel', 'Cancel')}</Button>
          <Button type="button" onClick={save}>{translate('auto.components.settings.CustomAgentDialog.save', 'Save agent')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
