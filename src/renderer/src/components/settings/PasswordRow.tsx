import { useState } from 'react'
import { Eye, EyeOff, Pencil, Trash2, Check, X } from 'lucide-react'
import type { BrowserCredentialEntry } from '../../../../shared/browser-credential-types'
import { hostnameFromOrigin } from '../../../../shared/browser-credential-hostname'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { translate } from '@/i18n/i18n'

type PasswordRowProps = {
  entry: BrowserCredentialEntry
  /** When true the vault is unavailable; block entering edit mode and saving edits. */
  disabled?: boolean
  onReveal: (id: string) => Promise<string | null>
  onUpdate: (
    id: string,
    username: string,
    password: string
  ) => Promise<BrowserCredentialEntry | null>
  onDelete: (entry: BrowserCredentialEntry) => Promise<void>
}

export function PasswordRow({
  entry,
  disabled = false,
  onReveal,
  onUpdate,
  onDelete
}: PasswordRowProps): React.JSX.Element {
  const [revealed, setRevealed] = useState(false)
  const [plaintext, setPlaintext] = useState<string | null>(null)
  const [revealing, setRevealing] = useState(false)

  const [editing, setEditing] = useState(false)
  const [editUsername, setEditUsername] = useState(entry.username)
  const [editPassword, setEditPassword] = useState('')
  const [saving, setSaving] = useState(false)

  const handleToggleReveal = async (): Promise<void> => {
    if (revealed) {
      // Hide — clear the plaintext from memory
      setRevealed(false)
      setPlaintext(null)
      return
    }
    setRevealing(true)
    try {
      const pwd = await onReveal(entry.id)
      setPlaintext(pwd)
      setRevealed(true)
    } finally {
      setRevealing(false)
    }
  }

  const handleEdit = (): void => {
    setEditUsername(entry.username)
    // Why: always start with empty password in edit mode — the stored value must
    // be fetched by an explicit Reveal action, not pre-populated automatically.
    setEditPassword('')
    setEditing(true)
  }

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      await onUpdate(entry.id, editUsername, editPassword)
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  const handleCancelEdit = (): void => {
    setEditing(false)
    setEditPassword('')
  }

  const displayHost = hostnameFromOrigin(entry.origin) ?? entry.origin

  if (editing) {
    return (
      <div className="flex items-start gap-3 rounded-md border border-border/50 bg-muted/20 p-3">
        <div className="min-w-0 flex-1 space-y-2">
          <p className="truncate text-xs font-medium text-muted-foreground">{displayHost}</p>
          <Input
            value={editUsername}
            onChange={(e) => setEditUsername(e.target.value)}
            placeholder={translate(
              'auto.components.settings.PasswordsPane.field_username_placeholder',
              'user@example.com'
            )}
            className="h-7 text-sm"
            disabled={saving}
          />
          <Input
            type="password"
            value={editPassword}
            onChange={(e) => setEditPassword(e.target.value)}
            placeholder={translate(
              'auto.components.settings.PasswordsPane.edit_password_placeholder',
              'New password (leave blank to keep current)'
            )}
            className="h-7 text-sm"
            disabled={saving}
          />
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            disabled={saving || !editUsername.trim() || disabled}
            onClick={() => void handleSave()}
          >
            <Check className="size-3.5" />
            {translate('auto.components.settings.PasswordsPane.save_btn', 'Save')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            disabled={saving}
            onClick={handleCancelEdit}
          >
            <X className="size-3.5" />
            {translate('auto.components.settings.PasswordsPane.cancel_btn', 'Cancel')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3 rounded-md border border-border/50 bg-muted/20 p-3">
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="truncate text-sm font-medium">{displayHost}</p>
        <p className="truncate text-xs text-muted-foreground">{entry.username}</p>
        <p className="font-mono text-xs text-muted-foreground/70">
          {revealed && plaintext !== null ? plaintext : '••••••••'}
        </p>
      </div>
      <div className="flex shrink-0 gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={revealing}
          onClick={() => void handleToggleReveal()}
          aria-label={
            revealed
              ? translate(
                  'auto.components.settings.PasswordsPane.hide_password_aria',
                  'Hide password'
                )
              : translate(
                  'auto.components.settings.PasswordsPane.reveal_password_aria',
                  'Reveal password'
                )
          }
        >
          {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          disabled={disabled}
          onClick={handleEdit}
          aria-label={translate('auto.components.settings.PasswordsPane.edit_aria', 'Edit login')}
        >
          <Pencil className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-destructive hover:text-destructive"
          onClick={() => void onDelete(entry)}
          aria-label={translate(
            'auto.components.settings.PasswordsPane.delete_aria',
            'Delete login'
          )}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
