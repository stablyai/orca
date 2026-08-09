import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { PluginHostInstallSource } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { parsePluginInstallSource } from './plugin-install-source'
import { pluginInstallErrorMessage } from './plugin-error-presentation'

type PluginInstallDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  onInstall: (source: PluginHostInstallSource) => Promise<void>
}

function installValidationMessage(reason: string): string {
  switch (reason) {
    case 'missing-local-path':
      return translate(
        'auto.components.settings.PluginInstallDialog.localRequired',
        'Enter the plugin folder path.'
      )
    case 'missing-git-url':
      return translate(
        'auto.components.settings.PluginInstallDialog.gitUrlRequired',
        'Enter a repository URL.'
      )
    case 'invalid-git-url':
      return translate(
        'auto.components.settings.PluginInstallDialog.gitUrlInvalid',
        'Use an HTTPS or SSH Git URL. Executable Git helper protocols are not allowed.'
      )
    default:
      return translate(
        'auto.components.settings.PluginInstallDialog.gitRefRequired',
        'Add an explicit #ref (tag or commit) so the install is pinned — for example #v0.1.0.'
      )
  }
}

export function PluginInstallDialog({
  open,
  onOpenChange,
  onInstall
}: PluginInstallDialogProps): React.JSX.Element {
  const [kind, setKind] = useState<'local-path' | 'git'>('local-path')
  const [localPath, setLocalPath] = useState('')
  const [gitUrl, setGitUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)

  const submit = async (): Promise<void> => {
    const parsed = parsePluginInstallSource(kind, kind === 'git' ? gitUrl : localPath)
    if (!parsed.ok) {
      setError(installValidationMessage(parsed.reason))
      return
    }
    setError(null)
    setInstalling(true)
    try {
      await onInstall(parsed.source)
    } catch (cause) {
      console.warn('[plugins] installation failed:', cause)
      setError(pluginInstallErrorMessage(cause))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !installing && onOpenChange(nextOpen)}>
      <DialogContent className="max-h-[calc(100vh-3rem)] overflow-y-auto scrollbar-sleek sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.PluginInstallDialog.title', 'Install plugin')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.PluginInstallDialog.description',
              'Installing copies the plugin into Orca and shows its permissions for review. No plugin code runs until you enable it.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <Tabs
            value={kind}
            onValueChange={(value) => {
              setKind(value as 'local-path' | 'git')
              setError(null)
            }}
          >
            <TabsList
              aria-label={translate(
                'auto.components.settings.PluginInstallDialog.source',
                'Install source'
              )}
            >
              <TabsTrigger value="local-path">
                {translate('auto.components.settings.PluginInstallDialog.localTab', 'Local folder')}
              </TabsTrigger>
              <TabsTrigger value="git">
                {translate('auto.components.settings.PluginInstallDialog.gitTab', 'Git URL')}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="local-path" className="space-y-2 pt-2">
              <Label htmlFor="plugin-local-path">
                {translate(
                  'auto.components.settings.PluginInstallDialog.localLabel',
                  'Plugin folder path'
                )}
              </Label>
              <Input
                id="plugin-local-path"
                className="font-mono text-xs"
                value={localPath}
                onChange={(event) => setLocalPath(event.target.value)}
                placeholder={translate(
                  'auto.components.settings.PluginInstallDialog.localPlaceholder',
                  '/Users/you/plugins/my-plugin or C:\\Users\\you\\plugins\\my-plugin'
                )}
                spellCheck={false}
                aria-invalid={kind === 'local-path' && Boolean(error)}
                aria-describedby={error ? 'plugin-install-error' : undefined}
                autoFocus
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginInstallDialog.localHelp',
                  'Full path to a folder containing orca-plugin.json on this computer. The path is used exactly as entered.'
                )}
              </p>
            </TabsContent>
            <TabsContent value="git" className="space-y-2 pt-2">
              <Label htmlFor="plugin-git-url">
                {translate(
                  'auto.components.settings.PluginInstallDialog.gitLabel',
                  'Repository URL with #ref'
                )}
              </Label>
              <Input
                id="plugin-git-url"
                className="font-mono text-xs"
                value={gitUrl}
                onChange={(event) => setGitUrl(event.target.value)}
                placeholder={translate(
                  'auto.components.settings.PluginInstallDialog.gitPlaceholder',
                  'https://git.example/acme/orca-notes#v0.1.0'
                )}
                spellCheck={false}
                aria-invalid={kind === 'git' && Boolean(error)}
                aria-describedby={error ? 'plugin-install-error' : undefined}
              />
              <p className="text-xs leading-5 text-muted-foreground">
                {translate(
                  'auto.components.settings.PluginInstallDialog.gitHelp',
                  'Append an explicit #ref — a tag or commit — so the install is pinned. Works with GitHub, GitLab, and any git host.'
                )}
              </p>
            </TabsContent>
          </Tabs>
          {error ? (
            <p id="plugin-install-error" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={installing}
              onClick={() => onOpenChange(false)}
            >
              {translate('auto.components.settings.PluginInstallDialog.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" className="w-31" disabled={installing}>
              {installing ? <Loader2 className="animate-spin" /> : null}
              {installing
                ? translate(
                    'auto.components.settings.PluginInstallDialog.installing',
                    'Installing…'
                  )
                : translate('auto.components.settings.PluginInstallDialog.install', 'Install')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
