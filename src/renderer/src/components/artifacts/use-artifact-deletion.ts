import { useState } from 'react'
import type {
  ArtifactCloudOperation,
  ArtifactListItem
} from '../../../../shared/artifacts/artifacts'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { persistConfirmationSkipPreference } from '@/components/dismiss/confirmation/confirmation-skip-preference'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { artifactName } from './artifact-display-labels'
import { artifactAccountIdentity } from './useArtifactPagination'

const LOCAL_RUNTIME = { kind: 'local' } as const
const NO_SLUGS: ReadonlySet<string> = new Set()

type DeletingState = { identity: string; slugs: ReadonlySet<string> }

function withoutSlug(current: DeletingState | null, identity: string, slug: string) {
  if (current?.identity !== identity || !current.slugs.has(slug)) {
    return current
  }
  const slugs = new Set(current.slugs)
  slugs.delete(slug)
  return slugs.size === 0 ? null : { identity, slugs }
}

/** One confirm for any number of artifacts, then deletes them one at a time so a failure stops the rest. */
export function useArtifactDeletion({
  accountIdentity,
  refreshAuth,
  removeArtifact,
  setError
}: {
  accountIdentity: string | null
  refreshAuth: () => Promise<unknown>
  removeArtifact: (identity: string, slug: string) => void
  setError: (error: string | null) => void
}): {
  deletingSlugs: ReadonlySet<string>
  deleteArtifacts: (items: readonly ArtifactListItem[]) => Promise<void>
} {
  const t = useTranslate()
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const confirm = useConfirmationDialog()
  const [deleting, setDeleting] = useState<DeletingState | null>(null)
  const deletingSlugs = deleting?.identity === accountIdentity ? deleting.slugs : NO_SLUGS

  const deleteArtifacts = async (requested: readonly ArtifactListItem[]): Promise<void> => {
    // Rows already being deleted are skipped so a second click never sends a duplicate request.
    const items = requested.filter(({ artifact }) => !deletingSlugs.has(artifact.slug))
    if (items.length === 0) {
      return
    }
    if (!settings?.skipDeleteArtifactConfirm) {
      const accepted = await confirm({
        title: t('common.delete', 'Delete'),
        description:
          items.length === 1
            ? t(
                'auto.components.artifacts.ArtifactsPage.deleteDescription',
                '“{{name}}” will no longer be available at its public link.',
                { name: artifactName(items[0]) }
              )
            : t(
                'auto.components.artifacts.ArtifactsPage.deleteManyDescription',
                '{{count}} artifacts will no longer be available at their public links.',
                { count: items.length }
              ),
        confirmLabel: t('auto.components.artifacts.ArtifactsPage.delete', 'Delete'),
        confirmVariant: 'destructive',
        dontAskAgain: {
          onConfirmed: () =>
            persistConfirmationSkipPreference({
              updates: { skipDeleteArtifactConfirm: true },
              settingsSectionId: 'general-skip-delete-artifact-confirm',
              updateSettings,
              openSettingsPage,
              openSettingsTarget
            })
        }
      })
      if (!accepted) {
        return
      }
    }
    const requestedIdentity = accountIdentity
    if (!requestedIdentity) {
      return
    }
    const requestedAccountIsCurrent = (): boolean =>
      artifactAccountIdentity(useAppStore.getState().orcaProfileAuthStatus) === requestedIdentity
    if (!requestedAccountIsCurrent()) {
      return
    }
    setDeleting((current) => {
      const slugs = new Set(current?.identity === requestedIdentity ? current.slugs : [])
      for (const { artifact } of items) {
        slugs.add(artifact.slug)
      }
      return { identity: requestedIdentity, slugs }
    })
    let failedCount = 0
    for (const [index, item] of items.entries()) {
      const slug = item.artifact.slug
      if (failedCount > 0 || !requestedAccountIsCurrent()) {
        setDeleting((current) => withoutSlug(current, requestedIdentity, slug))
        continue
      }
      try {
        const result = await callRuntimeRpc<ArtifactCloudOperation<void>>(
          LOCAL_RUNTIME,
          'artifacts.delete',
          { id: slug }
        )
        if (!requestedAccountIsCurrent()) {
          continue
        }
        if (result.status !== 'ok') {
          await refreshAuth()
          throw new Error(result.status)
        }
        removeArtifact(requestedIdentity, slug)
      } catch (deleteError) {
        console.error('Failed to delete artifact:', deleteError)
        failedCount = items.length - index
      } finally {
        setDeleting((current) => withoutSlug(current, requestedIdentity, slug))
      }
    }
    if (failedCount > 0 && requestedAccountIsCurrent()) {
      setError(
        failedCount === 1
          ? t(
              'auto.components.artifacts.ArtifactsPage.deleteFailed',
              'Could not delete the artifact.'
            )
          : t(
              'auto.components.artifacts.ArtifactsPage.deleteManyFailed',
              'Could not delete {{count}} artifacts.',
              { count: failedCount }
            )
      )
    }
  }

  return { deletingSlugs, deleteArtifacts }
}
