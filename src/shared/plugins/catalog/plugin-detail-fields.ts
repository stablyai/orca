import { z } from 'zod'
import { pluginFieldDoc, PLUGIN_MANIFEST_V2_SINCE } from '../manifest/plugin-schema-field-docs'

export const PLUGIN_CHANGELOG_MAX_LENGTH = 2_000

// Why a bounded grammar, not the SPDX list: the list changes, and the detail page only shows it.
const SPDX_ID = String.raw`[A-Za-z0-9][A-Za-z0-9.+-]*`
const SPDX_EXPRESSION_RE = new RegExp(
  `^\\(?${SPDX_ID}(?: (?:AND|OR|WITH) \\(?${SPDX_ID}\\)?)*\\)?$`
)

const spdxLicenseSchema = z
  .string()
  .max(128)
  .regex(SPDX_EXPRESSION_RE, 'must be an SPDX expression')

const httpsUrlSchema = z
  .string()
  .max(2048)
  .regex(/^https:\/\/\S+$/, 'must be an https URL')
  .refine((value) => URL.canParse(value), 'must be an https URL')

const releaseDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })])

// Why plain text: the detail page renders it as text, so markup would show literally.
const changelogSchema = z.string().min(1).max(PLUGIN_CHANGELOG_MAX_LENGTH)

const NEXT = PLUGIN_MANIFEST_V2_SINCE

/** Optional manifest fields shown on the plugin's detail page. */
export const pluginManifestDetailFields = {
  license: spdxLicenseSchema
    .optional()
    .meta(pluginFieldDoc('SPDX license expression.', NEXT, ['MIT', 'Apache-2.0 OR MIT'])),
  homepage: httpsUrlSchema
    .optional()
    .meta(pluginFieldDoc('Project homepage, https only.', NEXT, ['https://example.com/gleam']))
}

/** Why `.catch`: a newer or sloppy catalog must never hide a plugin over a display-only field, so
 *  an invalid value is dropped. The published schema still states the strict shape. */
export const pluginCatalogReleaseDetailFields = {
  license: spdxLicenseSchema
    .optional()
    .catch(undefined)
    .meta(pluginFieldDoc('SPDX license expression.', NEXT, ['MIT'])),
  repository: httpsUrlSchema
    .optional()
    .catch(undefined)
    .meta(
      pluginFieldDoc('Source repository page, https only.', NEXT, [
        'https://github.com/acme/orca-gleam-syntax'
      ])
    ),
  homepage: httpsUrlSchema
    .optional()
    .catch(undefined)
    .meta(pluginFieldDoc('Project homepage, https only.', NEXT, ['https://example.com/gleam'])),
  updatedAt: releaseDateSchema
    .optional()
    .catch(undefined)
    .meta(
      pluginFieldDoc('When this release was published, as an ISO 8601 date or date-time.', NEXT, [
        '2026-10-20'
      ])
    ),
  changelog: changelogSchema
    .optional()
    .catch(undefined)
    .meta(
      pluginFieldDoc(
        `What changed in this release, as plain text. At most ${PLUGIN_CHANGELOG_MAX_LENGTH} characters.`,
        NEXT,
        ['Adds highlighting for use expressions.']
      )
    )
}
