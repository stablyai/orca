import { Suspense, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Github, Image, Link2 } from 'lucide-react'
import type { RepoIcon } from '../../../../../../shared/repo-icon'
import { CLIPBOARD_IMAGE_TOO_LARGE_ERROR } from '../../../../../../shared/clipboard-image'
import {
  faviconUrlFromWebsite,
  MAX_REPO_ICON_UPLOAD_BYTES
} from '../../../../../../shared/repo-icon'
import { blobToBase64, convertImageBlobToPng } from '@/lib/image-blob-png'
import { Button } from '../../../ui/button'
import { LoadingSpinner } from '../../../LoadingSpinner'
import { Input } from '../../../ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../ui/tabs'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../../ui/tooltip'
import { getRepoLucideIconOptions } from '../../../repo/repo-icon'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { lazyWithRetry } from '@/lib/lazy-with-retry'
import { repoIconPickFailureText } from './repo-icon-pick-failure-text'

const RepositoryIconEmojiPicker = lazyWithRetry(
  () =>
    import('./RepositoryIconEmojiPicker').then((module) => ({
      default: module.RepositoryIconEmojiPicker
    })),
  { reloadKey: 'repo-icon-emoji-picker' }
)

export type RepositoryIconTabsHandle = {
  cancelUpload: () => void
}

type RepositoryIconTabsProps = {
  ref?: React.Ref<RepositoryIconTabsHandle>
  initialTab: 'avatar' | 'icon' | 'emoji'
  selectedLucideName: string | null
  selectedEmoji: string
  loadingGitHub: boolean
  onSetIcon: (repoIcon: RepoIcon | null) => void
  onUseGitHubAvatar: () => void
}

export function RepositoryIconTabs({
  ref,
  initialTab,
  selectedLucideName,
  selectedEmoji,
  loadingGitHub,
  onSetIcon,
  onUseGitHubAvatar
}: RepositoryIconTabsProps): React.JSX.Element {
  const [website, setWebsite] = useState('')
  const mountedRef = useMountedRef()
  const uploadRequest = useRef<symbol | null>(null)
  const [uploading, setUploading] = useState(false)
  const [showUploadSpinner, setShowUploadSpinner] = useState(false)

  useEffect(() => {
    if (!uploading) {
      setShowUploadSpinner(false)
      return
    }
    const timer = setTimeout(() => setShowUploadSpinner(true), 200)
    return () => clearTimeout(timer)
  }, [uploading])

  const cancelUpload = () => {
    uploadRequest.current = null
    setUploading(false)
  }

  useImperativeHandle(ref, () => ({ cancelUpload }))

  const handleSetIcon = (icon: RepoIcon | null) => {
    cancelUpload()
    onSetIcon(icon)
  }

  const handleUploadImage = async () => {
    if (uploadRequest.current) {
      return
    }
    const request = Symbol()
    uploadRequest.current = request
    setUploading(true)
    try {
      const result = await window.api.shell.pickRepoIconImage()
      if (!result || !mountedRef.current || uploadRequest.current !== request) {
        return
      }
      if ('error' in result) {
        toast.error(repoIconPickFailureText(result))
        return
      }
      const source = await (await fetch(result.dataUrl)).blob()
      const png = await convertImageBlobToPng(source, { maxEdge: 128 })
      if (png.size > MAX_REPO_ICON_UPLOAD_BYTES) {
        throw new Error('Repo icon image is too large.')
      }
      const dataUrl = `data:image/png;base64,${await blobToBase64(png)}`
      if (!mountedRef.current || uploadRequest.current !== request) {
        return
      }
      handleSetIcon({
        type: 'image',
        src: dataUrl,
        source: 'upload',
        label: result.fileName
      })
    } catch (error) {
      if (!mountedRef.current || uploadRequest.current !== request) {
        return
      }
      toast.error(
        error instanceof Error
          ? error.message === CLIPBOARD_IMAGE_TOO_LARGE_ERROR ||
            error.message.endsWith('Repo icon image must be 10MB or smaller.')
            ? translate(
                'auto.components.settings.RepositoryIconPicker.imageTooLarge',
                'Image exceeds the 10MB or 32-megapixel limit.'
              )
            : error.message
          : translate(
              'auto.components.settings.RepositoryIconPicker.868c5c9b56',
              'Failed to import repo icon'
            )
      )
    } finally {
      if (mountedRef.current && uploadRequest.current === request) {
        cancelUpload()
      }
    }
  }

  const handleUseWebsiteFavicon = () => {
    const src = faviconUrlFromWebsite(website)
    if (!src) {
      toast.error(
        translate(
          'auto.components.settings.RepositoryIconPicker.acf31559a0',
          'Enter a valid website URL.'
        )
      )
      return
    }
    handleSetIcon({
      type: 'image',
      src,
      source: 'favicon',
      label: translate(
        'auto.components.settings.RepositoryIconPicker.4d039317f4',
        'Website favicon'
      )
    })
  }

  return (
    <Tabs defaultValue={initialTab} className="gap-3">
      <TabsList variant="line" className="h-8">
        <TabsTrigger value="avatar" className="h-7 text-xs">
          {translate('auto.components.settings.RepositoryIconPicker.2d8bd302fa', 'Avatar')}
        </TabsTrigger>
        <TabsTrigger value="icon" className="h-7 text-xs">
          {translate('auto.components.settings.RepositoryIconPicker.b2d7fd2116', 'Icon')}
        </TabsTrigger>
        <TabsTrigger value="emoji" className="h-7 text-xs">
          {translate('auto.components.settings.RepositoryIconPicker.c490787d24', 'Emoji')}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="avatar" className="space-y-3">
        <Button
          type="button"
          variant="default"
          className="w-full gap-2"
          disabled={loadingGitHub}
          onClick={() => {
            cancelUpload()
            onUseGitHubAvatar()
          }}
        >
          <Github className="size-3.5" />
          {translate(
            'auto.components.settings.RepositoryIconPicker.39da8a10bf',
            'Use GitHub Avatar'
          )}
        </Button>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryIconPicker.7da623abcc',
            "Used by default — GitHub always provides one, even when the owner hasn't set a custom image."
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-2"
          disabled={uploading || loadingGitHub}
          aria-busy={uploading}
          onClick={() => void handleUploadImage()}
        >
          {uploading && showUploadSpinner ? (
            <LoadingSpinner className="size-3.5" />
          ) : (
            <Image className="size-3.5" />
          )}
          {translate('auto.components.settings.RepositoryIconPicker.381b4844fd', 'Upload image')}
        </Button>
        <div className="flex gap-2">
          <Input
            value={website}
            onChange={(event) => setWebsite(event.target.value)}
            placeholder={translate(
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
            {translate('auto.components.settings.RepositoryIconPicker.cc1286e263', 'Favicon')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryIconPicker.fde066a63b',
            'PNG, JPEG, SVG, WebP, GIF, BMP, ICO or AVIF. Up to 10MB and 32 megapixels.'
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
                  onClick={() => handleSetIcon({ type: 'lucide', name: option.name })}
                  aria-label={translate(
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
          <RepositoryIconEmojiPicker selectedEmoji={selectedEmoji} onSetIcon={handleSetIcon} />
        </Suspense>
      </TabsContent>
    </Tabs>
  )
}
