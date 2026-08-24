import { Loader2, Plus, X } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { getCustomProviderIconOptions } from './custom-provider-icon-options'
import { CustomProviderJsonPanel } from './CustomProviderJsonPanel'
import type { CustomProviderDraft } from './custom-provider-draft'
import type { CustomProviderUsageResult } from '../../../../shared/custom-provider-types'
import { translate } from '@/i18n/i18n'

type CustomProviderAccountFormProps = {
  open: boolean
  isEditing: boolean
  form: CustomProviderDraft
  saving: boolean
  testing: boolean
  testResult: CustomProviderUsageResult | null
  onFormChange: (updater: (prev: CustomProviderDraft) => CustomProviderDraft) => void
  onTest: () => void
  onSave: () => void
  onOpenChange: (open: boolean) => void
}

export function CustomProviderAccountForm({
  open,
  isEditing,
  form,
  saving,
  testing,
  testResult,
  onFormChange,
  onTest,
  onSave,
  onOpenChange
}: CustomProviderAccountFormProps): React.JSX.Element {
  // Why: progressive disclosure (usability review) — the mapping-mode fields,
  // which most users will never need to think hard about, stay hidden until
  // the basics are filled in. Deliberately independent of the token field —
  // a preset (or a user typing the URL first) should surface the filled-in
  // mapping right away, without also requiring a token just to see it.
  const basicsComplete = Boolean(form.displayName.trim() && form.usageUrl.trim() && form.icon)
  const canTest = Boolean(
    form.displayName.trim() &&
    form.usageUrl.trim().startsWith('https://') &&
    (form.token.trim() || form.tokenEnvVar.trim()) &&
    (form.mappingMode === 'percent'
      ? form.percentPath.trim()
      : form.usedPaths.some((p) => p.trim()) && form.limitPath.trim())
  )
  // Why: mandatory test-before-save (usability review, top priority) — Save
  // stays disabled until the current draft has a fresh successful test.
  const canSave = testResult?.status === 'ok'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100vh-3rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault()
            if (!saving && canSave) {
              onSave()
            }
          }}
        >
          <DialogHeader className="shrink-0 gap-1.5 border-b border-border/60 px-6 pt-6 pr-12 pb-4 text-left">
            <DialogTitle>
              {isEditing
                ? translate(
                    'auto.components.settings.CustomProviderAccountForm.editTitle',
                    'Edit custom provider'
                  )
                : translate(
                    'auto.components.settings.CustomProviderAccountForm.addTitle',
                    'Add custom provider'
                  )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.CustomProviderAccountForm.description',
                'Point Orca at an internal usage-tracking endpoint. No credentials leave this device except to the URL you enter.'
              )}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4 scrollbar-sleek">
            <div className="space-y-1.5">
              <Label htmlFor="cp-name">
                {translate('auto.components.settings.CustomProviderAccountForm.name', 'Name')}
              </Label>
              <Input
                id="cp-name"
                autoFocus
                value={form.displayName}
                onChange={(e) => onFormChange((f) => ({ ...f, displayName: e.target.value }))}
                placeholder={translate(
                  'auto.components.settings.CustomProviderAccountForm.namePlaceholder',
                  'Internal Gateway'
                )}
              />
            </div>

            <div className="space-y-1.5">
              <Label>
                {translate('auto.components.settings.CustomProviderAccountForm.icon', 'Icon')}
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {getCustomProviderIconOptions().map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    type="button"
                    title={label}
                    onClick={() => onFormChange((f) => ({ ...f, icon: id }))}
                    className={`flex size-8 items-center justify-center rounded-md border ${
                      form.icon === id
                        ? 'border-primary bg-primary/10'
                        : 'border-border/50 hover:bg-accent/50'
                    }`}
                  >
                    <Icon className="size-4" />
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cp-url">
                {translate('auto.components.settings.CustomProviderAccountForm.url', 'Usage URL')}
              </Label>
              <Input
                id="cp-url"
                value={form.usageUrl}
                onChange={(e) => onFormChange((f) => ({ ...f, usageUrl: e.target.value }))}
                placeholder={translate(
                  'auto.components.settings.CustomProviderAccountForm.urlPlaceholder',
                  'https://internal.example.com/usage?year={yyyy}&month={mm}&day={dd}'
                )}
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.settings.CustomProviderAccountForm.urlHelp',
                  // Why: {yyyy}/{mm}/{dd} placeholders substitute today's UTC date before
                  // every call — kept a small, documented grammar, not a full templating engine.
                  'Supports {yyyy}/{mm}/{dd} placeholders, replaced with today’s UTC date on every call.'
                )}
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cp-token">
                {translate(
                  'auto.components.settings.CustomProviderAccountForm.token',
                  'Bearer token'
                )}
              </Label>
              <Input
                id="cp-token"
                type="password"
                value={form.token}
                onChange={(e) => onFormChange((f) => ({ ...f, token: e.target.value }))}
                placeholder={
                  isEditing
                    ? translate(
                        'auto.components.settings.CustomProviderAccountForm.tokenEditPlaceholder',
                        'Leave blank to keep the existing token'
                      )
                    : translate(
                        'auto.components.settings.CustomProviderAccountForm.tokenPlaceholder',
                        'Bearer …'
                      )
                }
                spellCheck={false}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="cp-token-env-var">
                {translate(
                  'auto.components.settings.CustomProviderAccountForm.tokenEnvVar',
                  'Token env var (optional)'
                )}
              </Label>
              <Input
                id="cp-token-env-var"
                value={form.tokenEnvVar}
                onChange={(e) => onFormChange((f) => ({ ...f, tokenEnvVar: e.target.value }))}
                placeholder={translate(
                  'auto.components.settings.CustomProviderAccountForm.tokenEnvVarPlaceholder',
                  'MY_INTERNAL_API_KEY'
                )}
                spellCheck={false}
              />
              <p className="text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.settings.CustomProviderAccountForm.tokenEnvVarHelp',
                  'If this environment variable has a value on this machine, it is used instead of the Bearer token above — re-checked on every refresh.'
                )}
              </p>
            </div>

            {basicsComplete ? (
              <>
                <div className="space-y-1.5">
                  <Label>
                    {translate(
                      'auto.components.settings.CustomProviderAccountForm.mappingMode',
                      'Response mapping'
                    )}
                  </Label>
                  <Select
                    value={form.mappingMode}
                    onValueChange={(value) =>
                      onFormChange((f) => ({
                        ...f,
                        mappingMode: value as CustomProviderDraft['mappingMode']
                      }))
                    }
                  >
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">
                        {translate(
                          'auto.components.settings.CustomProviderAccountForm.percentMode',
                          'Percent field (0-100)'
                        )}
                      </SelectItem>
                      <SelectItem value="used-limit">
                        {translate(
                          'auto.components.settings.CustomProviderAccountForm.usedLimitMode',
                          'Used / limit fields'
                        )}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {form.mappingMode === 'percent' ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="cp-percent-path">
                      {translate(
                        'auto.components.settings.CustomProviderAccountForm.percentPath',
                        'Percent path'
                      )}
                    </Label>
                    <Input
                      id="cp-percent-path"
                      value={form.percentPath}
                      onChange={(e) => onFormChange((f) => ({ ...f, percentPath: e.target.value }))}
                      placeholder={translate(
                        'auto.components.settings.CustomProviderAccountForm.percentPathPlaceholder',
                        'usage.percent'
                      )}
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label>
                        {translate(
                          'auto.components.settings.CustomProviderAccountForm.usedPaths',
                          'Used-value paths (summed)'
                        )}
                      </Label>
                      {form.usedPaths.map((path, index) => (
                        <div key={index} className="flex gap-1.5">
                          <Input
                            value={path}
                            onChange={(e) =>
                              onFormChange((f) => ({
                                ...f,
                                usedPaths: f.usedPaths.map((p, i) =>
                                  i === index ? e.target.value : p
                                )
                              }))
                            }
                            placeholder={translate(
                              'auto.components.settings.CustomProviderAccountForm.usedPathPlaceholder',
                              'summary.totalInputTokens'
                            )}
                            spellCheck={false}
                          />
                          {form.usedPaths.length > 1 ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="xs"
                              onClick={() =>
                                onFormChange((f) => ({
                                  ...f,
                                  usedPaths: f.usedPaths.filter((_, i) => i !== index)
                                }))
                              }
                            >
                              <X className="size-3" />
                            </Button>
                          ) : null}
                        </div>
                      ))}
                      {form.usedPaths.length < 4 ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="xs"
                          className="gap-1.5"
                          onClick={() =>
                            onFormChange((f) => ({ ...f, usedPaths: [...f.usedPaths, ''] }))
                          }
                        >
                          <Plus className="size-3" />
                          {translate(
                            'auto.components.settings.CustomProviderAccountForm.addPath',
                            'Add another'
                          )}
                        </Button>
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="cp-limit-path">
                        {translate(
                          'auto.components.settings.CustomProviderAccountForm.limitPath',
                          'Limit path'
                        )}
                      </Label>
                      <Input
                        id="cp-limit-path"
                        value={form.limitPath}
                        onChange={(e) => onFormChange((f) => ({ ...f, limitPath: e.target.value }))}
                        placeholder={translate(
                          'auto.components.settings.CustomProviderAccountForm.limitPathPlaceholder',
                          'totalDailyLimit'
                        )}
                        spellCheck={false}
                      />
                    </div>
                  </>
                )}

                <div className="space-y-2 rounded-lg border border-border/60 bg-muted/20 p-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className="gap-1.5"
                    disabled={!canTest || testing}
                    onClick={onTest}
                  >
                    {testing ? <Loader2 className="size-3 animate-spin" /> : null}
                    {translate(
                      'auto.components.settings.CustomProviderAccountForm.test',
                      'Test & Preview'
                    )}
                  </Button>
                  {testResult ? (
                    testResult.status === 'ok' ? (
                      <p className="text-xs text-emerald-500">
                        {translate(
                          'auto.components.settings.CustomProviderAccountForm.testOk',
                          'Success — {{value0}}%',
                          { value0: Math.round(testResult.usedPercent ?? 0) }
                        )}
                      </p>
                    ) : (
                      <p className="text-xs text-red-400 [overflow-wrap:anywhere]">
                        {testResult.error ??
                          translate(
                            'auto.components.settings.CustomProviderAccountForm.testFailed',
                            'Test failed'
                          )}
                      </p>
                    )
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      {translate(
                        'auto.components.settings.CustomProviderAccountForm.testRequired',
                        'A successful test is required before saving.'
                      )}
                    </p>
                  )}
                </div>
              </>
            ) : null}

            <CustomProviderJsonPanel form={form} onFormChange={onFormChange} />
          </div>

          <DialogFooter className="shrink-0 gap-2 border-t border-border/60 bg-muted/10 px-6 py-4 sm:justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {translate('auto.components.settings.CustomProviderAccountForm.cancel', 'Cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={saving || !canSave}>
              {isEditing
                ? translate(
                    'auto.components.settings.CustomProviderAccountForm.saveChanges',
                    'Save Changes'
                  )
                : translate(
                    'auto.components.settings.CustomProviderAccountForm.addAccount',
                    'Add Account'
                  )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
