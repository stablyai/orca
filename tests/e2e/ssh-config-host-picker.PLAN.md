# E2E Test Plan: SSH config host picker (`import-ssh-config-does-nothing`)

## Branch summary

Users can open **Fill from ~/.ssh/config…** on the add-SSH-host dialog, pick a
Host alias, and get the form prefilled from `ssh -G` resolution. Bulk sync is a
secondary **Add all N to Orca** action (no re-adopt). Settings → SSH → **Import**
remains the deliberate re-adopt path.

Commits under test (vs main):

- `bd0b594dee` feat(ssh): add SSH config host picker for add-host form
- `dc8339369a` fix(ssh): import filter preservation and label fallback
- `5982c8108f` fix(ssh): harden config picker import, alias folding, host targeting
- `5cfb6369e7` refactor(ssh): centralize host result limit / folder group helper

## Already covered (do **not** re-test in E2E)

| Area | Where |
|------|--------|
| `listConfigHosts` / `resolveConfigHost` IPC registration | `src/main/ipc/ssh.test.ts` |
| Search, result limit, suppressed aliases, alreadyInOrca | `ssh-config-host-picker.test.ts` |
| Generation guard, freeze-while-resolving, late resolve | `AddRemoteHostDialog.config-picker.test.tsx` |
| Bulk `importConfig()` without `reAdopt` | `add-remote-host-ssh-actions.test.ts` |
| Alias folding / duplicate save check | `ssh-target-duplicate.test.ts` |
| `configured-only` host registry / setup fail-closed | unit tests in shared + project-host-workspace-target |
| Settings modal viewport stability | `ssh-host-form-modal.spec.ts` |

E2E is reserved for real Electron HOME isolation, real `~/.ssh/config` parse,
real `ssh -G` resolve, and user-visible DOM outcomes.

## Harness requirements

1. **Isolated HOME** — E2E already sets `HOME` to `{userDataDir}/home`. Seed config with:
   ```ts
   const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
   mkdirSync(path.join(home, '.ssh'), { recursive: true, mode: 0o700 })
   writeFileSync(path.join(home, '.ssh/config'), configBody, { mode: 0o600 })
   ```
2. **Unique aliases** — prefix Host entries and Orca labels with
   `e2e-ssh-cfg-${Date.now().toString(36)}-…` so workers never collide; clean up
   via `window.api.ssh.removeTarget` in `afterEach` by label/configHost prefix.
3. **Open the picker dialog** (not Settings `SshTargetForm` — that form has no
   config picker). Path:
   - Open **Add Project** (sidebar / landing control)
   - Host combobox → **Add remote host** → **Add SSH host**
   - Dialog title **Add SSH host** with link **Fill from ~/.ssh/config…**
4. **Assertions** — DOM only (`getByRole`, `toHaveValue`, visible badges/toasts).
   Store/API only for setup/cleanup/seeding existing targets.
5. **Prereq** — OpenSSH client on PATH (`ssh -G`). macOS/Linux CI has it; skip
   or soft-fail only if `ssh -G` is unavailable (document in test comment).

## Spec file

`tests/e2e/ssh-config-host-picker.spec.ts`  
Reuse patterns from `ssh-host-form-modal.spec.ts` (session ready, target cleanup,
announcement dismiss). Prefer small local helpers over new shared modules unless
helpers would be reused elsewhere.

Optional second file if the Settings Import case grows:  
`tests/e2e/ssh-config-import-settings.spec.ts` — otherwise keep Import in the same file.

---

## Cases (must ship)

### P1 — Empty config empty state

| | |
|--|--|
| **Setup** | Do not create `~/.ssh/config` (or write empty file). |
| **Steps** | Open Add SSH host → Fill from ~/.ssh/config… |
| **Expect** | Dialog title **Choose from ~/.ssh/config**; body **No hosts in ~/.ssh/config**; **Add all to Orca** disabled; **Back** returns to form. |

### P2 — Seeded hosts listed with summary lines

| | |
|--|--|
| **Setup** | Write config with ≥2 concrete Hosts, e.g. `e2e-alpha` / `e2e-bravo` with HostName, User, Port. |
| **Steps** | Open picker. |
| **Expect** | Host list `SSH config hosts` shows both aliases; subtitle `user@hostname:port`; button **Add all 2 to Orca** enabled. |

### P3 — Select host prefills form (and Save persists)

| | |
|--|--|
| **Setup** | Config Host `e2e-prod` → HostName `prod.example.test`, User `deploy`, Port `2222`. |
| **Steps** | Pick `e2e-prod` → wait for form → click **Save**. |
| **Expect** | After pick: Host/alias field = `prod.example.test`, Username `deploy`, Port `2222`, Label `e2e-prod` (or alias); optional toast *Filled from e2e-prod*; Identity file may stay empty with config hint. After Save: dialog closes; target appears in Settings → SSH (or listTargets shows matching host). |

### P4 — Filter narrows list

| | |
|--|--|
| **Setup** | Hosts `e2e-alpha`, `e2e-bravo`. |
| **Steps** | Open picker; filter `bravo`. |
| **Expect** | Only bravo row; alpha gone; **No matching hosts** if filter is nonsense. |

### P5 — Already-in-Orca badge + disabled row

| | |
|--|--|
| **Setup** | Config hosts alpha + bravo. Seed Orca target with `configHost`/`label` matching alpha (via `ssh.addTarget`). |
| **Steps** | Open picker. |
| **Expect** | Alpha shows **In Orca** badge and is not clickable; bravo still selectable; **Add all 1 to Orca** (not 2). |

### P6 — Add all N to Orca imports new hosts only

| | |
|--|--|
| **Setup** | Config with 2 new hosts; no Orca targets for them. |
| **Steps** | **Add all 2 to Orca** → wait for success toast / return to form or list refresh. |
| **Expect** | Both targets exist (DOM in Settings SSH and/or listTargets); re-open picker shows **All hosts already in Orca** / both **In Orca**. |

### P7 — Add all does **not** re-adopt deleted hosts

| | |
|--|--|
| **Setup** | Config with alpha + bravo; Add all → remove alpha via API (creates suppress tombstone). |
| **Steps** | Re-open picker; note count; optionally click Add all again. |
| **Expect** | Alpha absent from picker (suppressed) or not re-created; only new hosts counted; `listTargets` still lacks deleted alpha after second Add all. |

### P8 — Back discards pending pick path

| | |
|--|--|
| **Setup** | Seeded config. |
| **Steps** | Open picker → **Back** without selecting. |
| **Expect** | Form fields still empty (Host blank); no filled toast. |

### P9 — Settings Import re-adopts (contrast with P7)

| | |
|--|--|
| **Setup** | Same as P7 after delete. |
| **Steps** | Settings → SSH → **Import** (explicit reAdopt path). |
| **Expect** | Deleted config host reappears as an Orca target; toast sync count ≥ 1. |

---

## Nice-to-have (only if cheap after P1–P9)

- **N1** ProxyCommand / JumpHost: pick host with ProxyJump → Advanced opens and jump field filled (proves advanced prefill + `preferAdvancedOpen`).
- **N2** Case-insensitive alias: config `Prod`, existing label `prod` → **In Orca**.
- **N3** Empty Identity file hint visible after config fill.

Skip: 100-host truncation, resolve races, GSSAPI system-default, composer host-availability fail-closed (unit-covered).

## Out of scope

- Real SSH connect / relay / PTY
- Docker SSH fixtures
- Web client stub paths (`listConfigHosts` returns empty)
- i18n non-English

## Implementation status (done)

| Case | Spec |
|------|------|
| P1 empty state | `ssh-config-host-picker.spec.ts` |
| P2 list + Add all enabled | `ssh-config-host-picker.spec.ts` |
| P3 select + Save (+ N3 identity hint) | `ssh-config-host-picker.spec.ts` |
| P4 filter | `ssh-config-host-picker.spec.ts` |
| P5 In Orca badge / count | `ssh-config-host-import.spec.ts` |
| P6 Add all imports | `ssh-config-host-import.spec.ts` |
| P7 no re-adopt after delete | `ssh-config-host-import.spec.ts` |
| P8 Back without select | `ssh-config-host-picker.spec.ts` |
| P9 Settings Import re-adopts | `ssh-config-host-import.spec.ts` |

Shared helpers: `tests/e2e/helpers/ssh-config-host-picker.ts`

### Product fix required for E2E (and real HOME isolation)

OpenSSH resolves the default user config via **getpwuid**, not `$HOME`. E2E
sets an isolated `HOME`, so `loadUserSshConfig` (Node `os.homedir()`) and
`ssh -G` could disagree. `src/main/ssh/ssh-g-config-resolution.ts` now passes
`-F <homedir>/.ssh/config` when the HOME config path exists and differs from the
passwd home. Normal installs (HOME = passwd home) are unchanged.

## Suggested run command

```bash
pnpm exec electron-vite build --mode e2e
SKIP_BUILD=1 pnpm exec playwright test \
  tests/e2e/ssh-config-host-picker.spec.ts \
  tests/e2e/ssh-config-host-import.spec.ts \
  --config tests/playwright.config.ts --project=electron-headless --workers=1
```
