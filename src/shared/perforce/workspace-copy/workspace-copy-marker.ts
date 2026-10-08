import { readFile, writeFile } from 'node:fs/promises'
import type { WorkspaceCopyNames } from './workspace-copy-names'
import type { CopySource } from './workspace-copy-source'
import type { WorkspaceCopyMode } from './workspace-copy-types'

/**
 * The copy's marker (schema 1), written beside the copy and outside its client root so no reconcile
 * can add it. It tells an agent or script working in the copy what the copy is and how its work
 * goes back; scripts that make copies in the same layout read and write the same format.
 */
export type WorkspaceCopyMarker = {
  schema: 1
  name: string
  copyRoot: string
  client: string
  stream: string
  mode: WorkspaceCopyMode
  source: { client: string; root: string; stream: string }
  created: string
  updated: string
  handBack: string
  unityVersionControlBinding: string | null
  createdBy?: string
}

function handBackText(source: CopySource, stream: string, mode: WorkspaceCopyMode): string {
  const submit = `Submit finished work from this copy once it is tested here; sync and retest first if ${stream} has moved on. Shelve instead only to review it in the original workspace.`
  return mode === 'child'
    ? `This copy is on its own stream ${stream}. ${submit} Bring the work into ${source.stream} with p4 copy -S ${stream} from a workspace on that stream, then remove the copy.`
    : `This copy is on ${stream}. ${submit} Then remove the copy.`
}

export function buildMarker(args: {
  source: CopySource
  names: WorkspaceCopyNames
  stream: string
  mode: WorkspaceCopyMode
  unityVersionControlBinding: string | null
}): WorkspaceCopyMarker {
  const now = new Date().toISOString()
  const { source, names, stream, mode } = args
  return {
    schema: 1,
    name: names.name,
    copyRoot: names.copyRoot,
    client: names.client,
    stream,
    mode,
    source: { client: source.client, root: source.root, stream: source.stream },
    created: now,
    updated: now,
    handBack: handBackText(source, stream, mode),
    unityVersionControlBinding: args.unityVersionControlBinding,
    createdBy: 'orca'
  }
}

export async function writeMarker(path: string, marker: WorkspaceCopyMarker): Promise<void> {
  await writeFile(path, `${JSON.stringify(marker, null, 2)}\n`, 'utf8')
}

/** The marker's fields, or null when it is missing or not JSON. */
export async function readMarker(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse((await readFile(path, 'utf8')).replace(/^﻿/, ''))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.fromEntries(Object.entries(parsed))
      : null
  } catch {
    return null
  }
}

export function markerString(marker: Record<string, unknown> | null, key: string): string | null {
  const value = marker?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function markerMode(marker: Record<string, unknown> | null): WorkspaceCopyMode | null {
  const mode = markerString(marker, 'mode')
  return mode === 'same-stream' || mode === 'child' || mode === 'other-stream' ? mode : null
}
