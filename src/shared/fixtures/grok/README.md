# Grok Build compatibility fixtures

Golden inputs captured against Grok Build behavior (and the open-source
`xai-org/grok-build` contracts where noted). Use these from unit tests so Orca’s
Grok integration does not drift on:

| File | Contract |
|------|----------|
| `billing-*.json` | cli-chat-proxy billing / proto3 zero omission |
| `hook-stop-envelope.json` | Stop hook camelCase envelope |
| `chat_history-sample.jsonl` | Native chat / AI Vault transcript rows |
| `encode-cwd-goldens.json` | `encode_cwd_dirname` short + slug-blake3 long form |

`encode-cwd-goldens.json` is the OSS algorithm oracle. Wire it to
`encodeGrokCwdDirName` once that helper is on main (see related PRs).
