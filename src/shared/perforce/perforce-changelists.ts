import type { PerforceOperationResult } from './perforce-types'
import { rm } from 'node:fs/promises'
import { escapeP4FileArg, runP4, runP4OrThrow } from './p4-command'
import { parseTaggedOutput } from './p4-tagged-output'
import { fileArgs, toResult } from './perforce-mutations'

export async function shelveChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['shelve', '-f', '-c', String(changelist)], { cwd }))
}

export function buildChangeSpec(
  template: string,
  description: string,
  options: { dropFiles: boolean } = { dropFiles: true }
): string {
  const indented = description
    .trim()
    .split(/\r?\n/)
    .map((line) => `\t${line}`)
    .join('\n')
  const lines = template.split(/\r?\n/)
  const out: string[] = []
  let skipping = false
  for (const line of lines) {
    if (/^\S/.test(line)) {
      skipping = false
    }
    if (line.startsWith('Description:')) {
      out.push('Description:', indented)
      skipping = true
    } else if (options.dropFiles && line.startsWith('Files:')) {
      // Files move via `reopen`, so a new changelist starts empty.
      skipping = true
    } else if (!skipping) {
      out.push(line)
    }
  }
  return `${out.join('\n')}\n`
}

/** Creates a numbered changelist and moves the given files into it. */
export async function createChangelistWithFiles(
  cwd: string,
  description: string,
  filePaths: readonly string[]
): Promise<PerforceOperationResult & { changelist?: number }> {
  const template = await runP4OrThrow(['change', '-o'], { cwd })
  const created = await runP4(['change', '-i'], {
    cwd,
    input: buildChangeSpec(template, description)
  })
  const match = /Change (\d+) created/.exec(created.stdout)
  if (created.code !== 0 || !match) {
    return toResult(created)
  }
  const changelist = Number(match[1])
  if (filePaths.length > 0) {
    const moved = await moveFilesToChangelist(cwd, filePaths, changelist)
    if (!moved.success) {
      return { ...moved, changelist }
    }
  }
  return { success: true, output: created.stdout.trim(), changelist }
}

export async function moveFilesToChangelist(
  cwd: string,
  filePaths: readonly string[],
  changelist: number | 'default'
): Promise<PerforceOperationResult> {
  return toResult(
    await runP4(['reopen', '-c', String(changelist), ...fileArgs(filePaths)], { cwd })
  )
}

export async function deleteEmptyChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['change', '-d', String(changelist)], { cwd }))
}

export async function editChangelistDescription(
  cwd: string,
  changelist: number,
  description: string
): Promise<PerforceOperationResult> {
  const template = await runP4OrThrow(['change', '-o', String(changelist)], { cwd })
  return toResult(
    await runP4(['change', '-i'], {
      cwd,
      input: buildChangeSpec(template, description, { dropFiles: false })
    })
  )
}

/** Restores a changelist's shelved files into the same changelist, overwriting workspace copies. */
export async function unshelveChangelist(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(
    await runP4(['unshelve', '-f', '-s', String(changelist), '-c', String(changelist)], { cwd })
  )
}

/** Unshelves any pending changelist's shelf (including another user's) into the default or a numbered changelist. */
export async function unshelveFrom(
  cwd: string,
  sourceChangelist: number,
  target: 'default' | number
): Promise<PerforceOperationResult> {
  return toResult(
    await runP4(['unshelve', '-f', '-s', String(sourceChangelist), '-c', String(target)], { cwd })
  )
}

/** Shelves the given opened files of a changelist, then reverts them (their changes live only in the shelf). */
export async function shelveAndRevertFiles(
  cwd: string,
  changelist: number,
  filePaths: readonly string[]
): Promise<PerforceOperationResult> {
  const shelved = toResult(
    await runP4(['shelve', '-f', '-c', String(changelist), ...fileArgs(filePaths)], { cwd })
  )
  // Why: never revert files whose changes did not reach the shelf.
  if (!shelved.success) {
    return shelved
  }
  return toResult(await runP4(['revert', ...fileArgs(filePaths)], { cwd }))
}

/** Restores only the given shelved files into their own changelist, overwriting workspace copies. */
export async function unshelveFiles(
  cwd: string,
  changelist: number,
  depotPaths: readonly string[]
): Promise<PerforceOperationResult> {
  return toResult(
    await runP4(
      [
        'unshelve',
        '-f',
        '-s',
        String(changelist),
        '-c',
        String(changelist),
        ...depotPaths.map(escapeP4FileArg)
      ],
      { cwd }
    )
  )
}

/** Deletes the shelf, reverts every opened file in the changelist, then deletes the changelist. */
export async function deleteChangelistWithFiles(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  const id = String(changelist)
  // Why: the shelf must go first (p4 refuses to delete a changelist that has one); no shelf is not an error.
  await runP4(['shelve', '-d', '-c', id], { cwd })
  const opened = await runP4(
    ['-ztag', 'fstat', '-Ro', '-e', id, '-T', 'clientFile,action', '//...'],
    {
      cwd
    }
  )
  const added = parseTaggedOutput(opened.stdout)
    .filter((record) => record.action === 'add' || record.action === 'branch')
    .map((record) => record.clientFile)
  const reverted = await runP4(['revert', '-c', id, '//...'], { cwd })
  // Why: "no file(s) to revert" is a non-zero exit for an already-empty changelist.
  if (reverted.code !== 0 && !/not opened|no file/i.test(reverted.stderr)) {
    return toResult(reverted)
  }
  for (const file of added) {
    if (file) {
      await rm(file, { force: true })
    }
  }
  return toResult(await runP4(['change', '-d', id], { cwd }))
}

export async function deleteShelf(
  cwd: string,
  changelist: number
): Promise<PerforceOperationResult> {
  return toResult(await runP4(['shelve', '-d', '-c', String(changelist)], { cwd }))
}
