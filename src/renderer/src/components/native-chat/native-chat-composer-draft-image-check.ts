// Restored store images are checked only with affirmative execution-host ownership.

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { chatImageAccess } from '@/lib/local-file-access'
import { isAgentSessionAttachmentStorePath } from '../../../../shared/agent-session-attachments'
import {
  records,
  restoredImageChecks,
  restoredImageKey,
  NO_IMAGE_CHECKS,
  notifyScope,
  type DraftImageCheck
} from './native-chat-composer-draft-memory'
import type { NativeChatComposerDraftImage } from './native-chat-composer-draft-storage'
import {
  isKeptLocalPaste,
  resolveNativeChatComposerDraftOwner,
  structuredAgentSessionIdOfDraftScope,
  readNativeChatComposerDraft,
  unavailableNativeChatComposerDraftImage,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'

/** Ids of images whose file is gone. One that cannot be checked (no read permission for that
 *  path, host not connected) counts as present: the send's own check still guards it. */
export async function findMissingNativeChatComposerDraftImages(
  images: readonly NativeChatComposerDraftImage[]
): Promise<Set<string>> {
  const api = typeof window === 'undefined' ? undefined : window.api
  const missing = new Set<string>()
  const checkable = images.filter((image) => image.unavailableName === undefined && image.path)
  const pastes = checkable.filter(isKeptLocalPaste)
  if (pastes.length > 0 && api?.ui?.restoreNativeChatPastes) {
    try {
      const restored = await api.ui.restoreNativeChatPastes(pastes.map(({ path }) => path))
      const kept = new Set(restored.filter((r) => r.kept && r.exists).map(({ path }) => path))
      pastes.filter(({ path }) => !kept.has(path)).forEach(({ id }) => missing.add(id))
    } catch {
      // Unknown, not gone.
    }
  }
  const pathExists = api?.fs?.pathExists
  if (!pathExists) {
    return missing
  }
  await Promise.all(
    checkable
      .filter((image) => !isKeptLocalPaste(image))
      .map(async (image) => {
        try {
          const exists = await pathExists({
            filePath: image.path,
            ...(isAgentSessionAttachmentStorePath(image.path) ? { access: chatImageAccess() } : {}),
            ...(image.connectionId ? { connectionId: image.connectionId } : {})
          })
          if (!exists) {
            missing.add(image.id)
          }
        } catch {
          // Unknown, not gone.
        }
      })
  )
  return missing
}

function localStoreAuthority(scopeKey: string): string | null {
  const stored = readNativeChatComposerDraft(scopeKey).owner
  const current = resolveNativeChatComposerDraftOwner(scopeKey)
  return structuredAgentSessionIdOfDraftScope(scopeKey) !== null &&
    (stored ?? current)?.executionHostId === 'local' &&
    (!current || current.executionHostId === 'local')
    ? JSON.stringify([stored, current])
    : null
}

function checkAuthority(image: NativeChatComposerDraftImage, local: string | null): string | null {
  return isAgentSessionAttachmentStorePath(image.path)
    ? image.connectionId
      ? null
      : local
    : 'path'
}

function replaceCheck(scopeKey: string, entry: DraftImageCheck, next?: DraftImageCheck): void {
  const checks = restoredImageChecks.get(scopeKey)
  if (!checks?.includes(entry)) {
    return
  }
  restoredImageChecks.set(
    scopeKey,
    checks.flatMap((held) => (held === entry ? (next ? [next] : []) : [held]))
  )
  if (restoredImageChecks.get(scopeKey)?.length === 0) {
    restoredImageChecks.delete(scopeKey)
  }
  notifyScope(scopeKey)
}

function attemptIsCurrent(scopeKey: string, entry: DraftImageCheck): boolean {
  return (
    !!entry.attempt &&
    restoredImageChecks.get(scopeKey)?.includes(entry) === true &&
    readNativeChatComposerDraft(scopeKey).images.some(
      (image) => restoredImageKey(image) === restoredImageKey(entry.image)
    ) &&
    entry.attempt.authority === checkAuthority(entry.image, localStoreAuthority(scopeKey))
  )
}

async function runCheck(scopeKey: string, entry: DraftImageCheck): Promise<void> {
  try {
    const missing = await findMissingNativeChatComposerDraftImages([entry.image])
    if (attemptIsCurrent(scopeKey, entry) && missing.has(entry.image.id)) {
      updateNativeChatComposerDraft(
        scopeKey,
        {
          images: readNativeChatComposerDraft(scopeKey).images.map((image) =>
            restoredImageKey(image) === restoredImageKey(entry.image)
              ? unavailableNativeChatComposerDraftImage(image)
              : image
          )
        },
        'immediate'
      )
    }
  } finally {
    if (attemptIsCurrent(scopeKey, entry)) {
      replaceCheck(scopeKey, entry)
    }
  }
}

export async function verifyRestoredNativeChatComposerDraftImages(scopeKey: string): Promise<void> {
  await Promise.all(
    (restoredImageChecks.get(scopeKey) ?? NO_IMAGE_CHECKS).map(async (entry) => {
      const authority = checkAuthority(entry.image, localStoreAuthority(scopeKey))
      if (entry.attempt && entry.attempt.authority !== authority) {
        replaceCheck(scopeKey, entry, { image: entry.image })
      } else if (!entry.attempt && authority !== null) {
        const claimed = { image: entry.image, attempt: { authority } }
        replaceCheck(scopeKey, entry, claimed)
        if (restoredImageChecks.get(scopeKey)?.includes(claimed)) {
          await runCheck(scopeKey, claimed)
        }
      }
    })
  )
}

function isInsideUploadDir(path: string, uploadDir: string): boolean {
  return (
    path.startsWith(uploadDir) &&
    (path[uploadDir.length] === '/' || path[uploadDir.length] === '\\')
  )
}

/** A sweep may have removed this local upload folder after a draft's restore check said its image
 *  was there, so every loaded draft naming it checks again, whether its composer is shown or not. */
export function recheckNativeChatComposerDraftImagesIn(uploadDir: string): void {
  for (const scopeKey of records.keys()) {
    const named = readNativeChatComposerDraft(scopeKey).images.filter(
      (image) =>
        image.unavailableName === undefined &&
        !image.connectionId &&
        !!image.path &&
        isInsideUploadDir(image.path, uploadDir)
    )
    if (named.length === 0) {
      continue
    }
    // A fresh entry replaces any attempt in flight, whose answer predates the removal.
    const keys = new Set(named.map(restoredImageKey))
    restoredImageChecks.set(scopeKey, [
      ...(restoredImageChecks.get(scopeKey) ?? NO_IMAGE_CHECKS).filter(
        (entry) => !keys.has(restoredImageKey(entry.image))
      ),
      ...named.map((image) => ({ image }))
    ])
    notifyScope(scopeKey)
    void verifyRestoredNativeChatComposerDraftImages(scopeKey)
  }
}

/** Only an eligible image's finite restore work holds its chip, independent of deferred peers. */
export function useRestoredNativeChatComposerDraftImageCheck(
  scopeKey: string,
  subscribe: (listener: () => void) => () => void
): ReadonlySet<string> {
  const checks = useSyncExternalStore(
    subscribe,
    () => restoredImageChecks.get(scopeKey) ?? NO_IMAGE_CHECKS
  )
  const local = useAppStore(() => localStoreAuthority(scopeKey))
  const pending = useMemo(
    () =>
      new Set(
        checks
          .filter(
            (entry) =>
              checkAuthority(entry.image, local) !== null &&
              (isKeptLocalPaste(entry.image) || isAgentSessionAttachmentStorePath(entry.image.path))
          )
          .map((entry) => restoredImageKey(entry.image))
      ),
    [checks, local]
  )
  useEffect(() => {
    void verifyRestoredNativeChatComposerDraftImages(scopeKey)
  }, [scopeKey, checks, local])
  return pending
}
