import { Suspense, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Github, Image, Link2 } from 'lucide-react'
import type { RepoIcon } from '../../../../../../shared/repository/appearance/repo-icon'
import {
  faviconUrlFromWebsite,
  MAX_REPO_ICON_UPLOAD_BYTES
} from '../../../../../../shared/repository/appearance/repo-icon'
import {
  isRepoIconPickFailure,
  type RepoIconPickPendingResult,
  type RepoIconPickResult
} from '../../../../../../shared/repository/appearance/repo-icon-pick-result'
import { formatBytes } from '../../../../../../shared/text/format-bytes'
import { Button } from '../../../ui/button'
import { Input } from '../../../ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { getRepoLucideIconOptions } from '../../../repo/repo-icon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { RepositoryIconImageDialog } from './RepositoryIconImageDialog'
import { repoIconPickFailureText } from './repo-icon-pick-failure-text'

const RepositoryIconEmojiPicker = lazyWithRetry(
  () =>
    import('./RepositoryIconEmojiPicker').then((module) => ({
      default: module.RepositoryIconEmojiPicker
    })),
  { reloadKey: 'repo-icon-emoji-picker' }
)

type RepositoryIconTabsProps = {
  initialTab: 'avatar' | 'icon' | 'emoji'
  selectedLucideName: string | null
  selectedEmoji: string
  loadingGitHub: boolean
  onSetIcon: (repoIcon: RepoIcon | null) => void
  onUseGitHubAvatar: () => void
}

// Module level: React Compiler can't lower try/finally inside a component.
async function runRepoIconPick(
  onResult: (result: RepoIconPickResult) => void,
  onError: (error: unknown) => void,
  onSettled: () => void
): Promise<void> {
  try {
    onResult(await window.api.shell.pickRepoIconImage())
  } catch (error) {
    onError(error)
  } finally {
    onSettled()
  }
}

export function RepositoryIconTabs({
  initialTab,
  selectedLucideName,
  selectedEmoji,
  loadingGitHub,
  onSetIcon,
  onUseGitHubAvatar
}: RepositoryIconTabsProps): React.JSX.Element {
  const t = useTranslate()
  const [website, setWebsite] = useState('')
  const [picking, setPicking] = useState(false)
  const [pending, setPending] = useState<RepoIconPickPendingResult | null>(null)
  const mountedRef = useMountedRef()
  const requestRef = useRef(0)

  const discardSelection = (): void => {
    requestRef.current += 1
    setPending(null)
    setPicking(false)
  }

  const handlePickImage = async (): Promise<void> => {
    const request = requestRef.current + 1
    requestRef.current = request
    setPicking(true)
    await runRepoIconPick(
      (result) => {
        if (!mountedRef.current || request !== requestRef.current || !result) {
          return
        }
        if (isRepoIconPickFailure(result)) {
          toast.error(repoIconPickFailureText(result))
          return
        }
        if (result.kind === 'direct') {
          onSetIcon({
            type: 'image',
            src: result.dataUrl,
            source: 'upload',
            label: result.fileName
          })
          return
        }
        setPending(result)
      },
      (error) => {
        if (request === requestRef.current) {
          toast.error(
            error instanceof Error
              ? error.message
              : t(
                  'auto.components.settings.RepositoryIconPicker.868c5c9b56',
                  'Failed to import repo icon'
                )
          )
        }
      },
      () => {
        if (request === requestRef.current) {
          setPicking(false)
        }
      }
    )
  }

  const handleUseWebsiteFavicon = () => {
    const src = faviconUrlFromWebsite(website)
    if (!src) {
      toast.error(
        t('auto.components.settings.RepositoryIconPicker.acf31559a0', 'Enter a valid website URL.')
      )
      return
    }
    onSetIcon({
      type: 'image',
      src,
      source: 'favicon',
      label: t('auto.components.settings.RepositoryIconPicker.4d039317f4', 'Website favicon')
    })
  }

  return (
    <Tabs defaultValue={initialTab} className="gap-3">
      <TabsList variant="line" className="h-8">
        <TabsTrigger value="avatar" className="h-7 text-xs">
          {t('auto.components.settings.RepositoryIconPicker.2d8bd302fa', 'Avatar')}
        </TabsTrigger>
        <TabsTrigger value="icon" className="h-7 text-xs">
          {t('auto.components.settings.RepositoryIconPicker.b2d7fd2116', 'Icon')}
        </TabsTrigger>
        <TabsTrigger value="emoji" className="h-7 text-xs">
          {t('auto.components.settings.RepositoryIconPicker.c490787d24', 'Emoji')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="avatar" className="space-y-3">
        <Button
          type="button"
          variant="default"
          className="w-full gap-2"
          disabled={loadingGitHub}
          onClick={() => void onUseGitHubAvatar()}
        >
          <Github className="size-3.5" />
          {t('auto.components.settings.RepositoryIconPicker.cc76342291', 'Use GitHub avatar')}
        </Button>
        <p className="text-xs text-muted-foreground">
          {t(
            'auto.components.settings.RepositoryIconPicker.7da623abcc',
            "Used by default — GitHub always provides one, even when the owner hasn't set a custom image."
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={picking}
          onClick={() => void handlePickImage()}
        >
          <Image className="size-3.5" />
          {t('settings.repository.iconPreview.upload', 'Upload PNG or JPEG')}
        </Button>
        <div className="flex gap-2">
          <Input
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            placeholder={t(
              'auto.components.settings.RepositoryIconPicker.03ca1a4e9b',
              'example.com'
            )}
            className="h-9 text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 gap-2"
            onClick={handleUseWebsiteFavicon}
          >
            <Link2 className="size-3.5" />
            {t('auto.components.settings.RepositoryIconPicker.cc1286e263', 'Favicon')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'settings.repository.iconPreview.uploadHelp',
            'PNG and JPEG uploads. Large images and JPEGs are converted to a PNG of {{limit}} or smaller.',
            { limit: formatBytes(MAX_REPO_ICON_UPLOAD_BYTES) }
          )}
        </p>
      </TabsContent>

      <TabsContent value="icon" className="space-y-3">
        <div className="grid grid-cols-10 gap-1.5">
          {getRepoLucideIconOptions().map((option) => (
            <Tooltip key={option.name}>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant={selectedLucideName === option.name ? 'secondary' : 'ghost'}
                  size="icon-xs"
                  className="size-8"
                  onClick={() => onSetIcon({ type: 'lucide', name: option.name })}
                  aria-label={t(
                    'auto.components.settings.RepositoryIconPicker.useRepoIcon',
                    'Use {{value0}} repo icon',
                    { value0: option.label }
                  )}
                >
                  <option.icon className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {option.label}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </TabsContent>

      <TabsContent value="emoji">
        <Suspense fallback={null}>
          <RepositoryIconEmojiPicker selectedEmoji={selectedEmoji} onSetIcon={onSetIcon} />
        </Suspense>
      </TabsContent>

      <RepositoryIconImageDialog
        key={pending?.token ?? 'idle'}
        pending={pending}
        onUse={(dataUrl, fileName) => {
          onSetIcon({ type: 'image', src: dataUrl, source: 'upload', label: fileName })
          discardSelection()
        }}
        onCancel={discardSelection}
        onReselect={() => {
          discardSelection()
          void handlePickImage()
        }}
      />
    </Tabs>
  )
}
