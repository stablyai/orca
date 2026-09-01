import { isValidNpmPackageName } from '../../../../shared/npm-package-name'
import { locatePackageJsonDependencyAtOffset } from './package-json-dependency-location'
import { buildPackageJsonDependencyHoverMarkdown } from './package-json-dependency-hover-markdown'
import type { InstalledPackageVersionResult } from './package-json-installed-version'
import type { PackageJsonDependencyHoverContext } from './package-json-dependency-hover-context'
import type {
  NpmPackageInfoRequest,
  NpmPackageInfoResult
} from '../../../../shared/npm-package-info-types'

export type PackageJsonDependencyHoverResult = {
  markdown: string
  startOffset: number
  endOffset: number
}

export type PackageJsonDependencyHoverResolutionParams = {
  modelText: string
  offset: number
  isCancelled: () => boolean
  resolveContext: () => PackageJsonDependencyHoverContext | undefined
  resolveInstalledVersion: (
    context: PackageJsonDependencyHoverContext,
    packageName: string
  ) => Promise<InstalledPackageVersionResult>
  /** `undefined` on Orca web (see the fallback note below), or when unregistered. */
  lookupPackageInfo:
    | ((request: NpmPackageInfoRequest) => Promise<NpmPackageInfoResult | undefined>)
    | undefined
}

/**
 * Orchestrates one hover: locate the key, resolve host context, read the
 * installed version (always, offline-safe), then the network-backed lookup.
 * Checks cancellation after each `await` — Monaco hover contents are
 * immutable once returned, so a stale in-flight result must never resolve.
 */
export async function resolvePackageJsonDependencyHover(
  params: PackageJsonDependencyHoverResolutionParams
): Promise<PackageJsonDependencyHoverResult | null> {
  const location = locatePackageJsonDependencyAtOffset(params.modelText, params.offset)
  if (!location || params.isCancelled()) {
    return null
  }
  // Why here and not only at the IPC boundary: the key comes from a file the
  // user opened, and it is concatenated into `node_modules/<key>/package.json`
  // for the installed-version read. A key containing `..` would walk out of
  // the worktree, and on a remote host the read still goes through the relay.
  if (!isValidNpmPackageName(location.packageName)) {
    return null
  }
  const context = params.resolveContext()
  if (!context || params.isCancelled()) {
    return null
  }
  const installedVersion = await params.resolveInstalledVersion(context, location.packageName)
  if (params.isCancelled()) {
    return null
  }
  // Why: Orca web's `withFallback` proxy resolves `.lookup(...)` to
  // `undefined` rather than leaving `npmPackageInfo` itself undefined.
  // Folding that into `lookup-disabled` keeps the installed-version read
  // visible instead of dropping the whole hover.
  const rawResult = params.lookupPackageInfo
    ? await params.lookupPackageInfo({
        packageName: location.packageName,
        executionHostId: context.executionHostId
      })
    : undefined
  if (params.isCancelled()) {
    return null
  }
  const result: NpmPackageInfoResult = rawResult ?? { status: 'lookup-disabled' }
  const markdown = buildPackageJsonDependencyHoverMarkdown({
    packageName: location.packageName,
    installedVersion,
    result
  })
  // Nothing known about the package: no hover at all rather than a tooltip
  // that only explains our own failure.
  if (!markdown) {
    return null
  }
  return { markdown, startOffset: location.startOffset, endOffset: location.endOffset }
}
