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

/** Module-level so the hook stays compilable: React Compiler cannot lower try/catch with a throw. */
async function deleteOneArtifact(
  slug: string,
  requestedAccountIsCurrent: () => boolean,
  refreshAuth: () => Promise<unknown>
): Promise<'deleted' | 'stale' | 'failed'> {
  try {
    const result = await callRuntimeRpc<ArtifactCloudOperation<void>>(
      LOCAL_RUNTIME,
      'artifacts.delete',
      { id: slug }
    )
    if (!requestedAccountIsCurrent()) {
      return 'stale'
    }
    if (result.status !== 'ok') {
      await refreshAuth()
      console.error('Failed to delete artifact:', result.status)
      return 'failed'
    }
    return 'deleted'
  } catch (deleteError) {
    console.error('Failed to delete artifact:', deleteError)
    return 'failed'
  }
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
    // From the request, not the filtered list: a bulk action keeps its confirm even when busy rows leave one.
    const bulk = requested.length > 1
    // Why: "Don't ask again" was given for one artifact at a time; it never waives a bulk confirm.
    if (bulk || !settings?.skipDeleteArtifactConfirm) {
      const accepted = await confirm({
        title: t('common.delete', 'Delete'),
        description: bulk
          ? t(
              'auto.components.artifacts.ArtifactsPage.deleteManyDescription',
              '{{count}} artifacts will no longer be available at their public links.',
              {
                count: items.length,
                defaultValue_one:
                  '{{count}} artifact will no longer be available at its public link.'
              }
            )
          : t(
              'auto.components.artifacts.ArtifactsPage.deleteDescription',
              '“{{name}}” will no longer be available at its public link.',
              { name: artifactName(items[0]) }
            ),
        confirmLabel: t('auto.components.artifacts.ArtifactsPage.delete', 'Delete'),
        confirmVariant: 'destructive',
        dontAskAgain: bulk
          ? undefined
          : {
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
    let failed: { item: ArtifactListItem; untried: number } | null = null
    for (const [index, item] of items.entries()) {
      const slug = item.artifact.slug
      if (failed || !requestedAccountIsCurrent()) {
        setDeleting((current) => withoutSlug(current, requestedIdentity, slug))
        continue
      }
      const outcome = await deleteOneArtifact(slug, requestedAccountIsCurrent, refreshAuth)
      if (outcome === 'deleted') {
        removeArtifact(requestedIdentity, slug)
      } else if (outcome === 'failed') {
        failed = { item, untried: items.length - index - 1 }
      }
      setDeleting((current) => withoutSlug(current, requestedIdentity, slug))
    }
    if (failed && requestedAccountIsCurrent()) {
      // The failed row and any rows after it stay listed and checked, so the batch can be retried.
      setError(
        !bulk
          ? t(
              'auto.components.artifacts.ArtifactsPage.deleteFailed',
              'Could not delete the artifact.'
            )
          : failed.untried === 0
            ? t(
                'auto.components.artifacts.ArtifactsPage.deleteNamedFailed',
                'Could not delete “{{name}}”.',
                { name: artifactName(failed.item) }
              )
            : t(
                'auto.components.artifacts.ArtifactsPage.deleteBatchStopped',
                'Could not delete “{{name}}”. {{count}} more were not deleted.',
                {
                  name: artifactName(failed.item),
                  count: failed.untried,
                  defaultValue_one: 'Could not delete “{{name}}”. {{count}} more was not deleted.'
                }
              )
      )
    }
  }

  return { deletingSlugs, deleteArtifacts }
}
