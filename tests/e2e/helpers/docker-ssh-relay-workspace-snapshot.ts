import { expect, type Page } from '@stablyai/playwright-test'

import {
  execDockerSshRelayTargetControlCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

/** Where the relay persists a target's workspace snapshot inside the fixture container. */
const REMOTE_SNAPSHOT_DIR = '/root/.orca/sessions'

export async function readTargetSyncPhase(
  page: Page,
  targetId: string
): Promise<string | undefined> {
  return page.evaluate(
    (id) => window.__store?.getState().remoteWorkspaceSyncStatusByTargetId[id]?.phase,
    targetId
  )
}

function findRemoteSnapshotPath(target: DockerSshRelayTarget): string | null {
  const listing = execDockerSshRelayTargetControlCommand(
    target,
    `ls -1 ${REMOTE_SNAPSHOT_DIR}/*.json 2>/dev/null || true`
  ).trim()
  return listing.split('\n').find((line) => line.endsWith('.json')) ?? null
}

export async function waitForUploadedRemoteSnapshot(target: DockerSshRelayTarget): Promise<string> {
  let snapshotPath: string | null = null
  await expect
    .poll(
      () => {
        snapshotPath = findRemoteSnapshotPath(target)
        return snapshotPath
      },
      { timeout: 60_000, message: 'the relay never persisted a workspace snapshot' }
    )
    .not.toBeNull()
  return snapshotPath!
}
